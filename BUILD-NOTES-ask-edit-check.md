# Build notes: Ask, Edit, Door check (branch `cloud/ask-edit-check`)

Written for Brandan in plain language. Updated after every numbered item, because the
cloud session can stop at any time. Base branch: `reference-library`.

Nothing here has been deployed or run against the live database. Everything was
tested with fakes in this cloud computer.

## Status
| # | Item | Status |
|---|------|--------|
| 1 | Telegram lock | done (lock already existed, kept as is, tests added) |
| 2 | Ask mode | done (tested with fakes) |
| 3 | Edit notes | done (SQL tested in PGlite, edge logic with fakes) |
| 4 | Door check | done (tested with fakes) |

## 1. Telegram lock

**What I found.** The task said the bot accepted any sender. On the `reference-library`
branch that is no longer true: `telegram-bot/index.ts` already has the lock (see the
2026-11-03 line in DECISIONS.md). It:
- refuses everything (401) if `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_OWNER_ID` is missing,
- refuses (401) any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match,
- answers a silent 200 to any sender whose `message.from.id` isn't `TELEGRAM_OWNER_ID`,
- has a `{"setup": true}` request (needs the secret header) that re-registers the webhook with the secret.

**What I changed.** Nothing in the lock itself. The rules said "if a check already exists,
keep it and don't add a second one".

**One difference from the task wording, kept on purpose.** The task says "keep returning
200 to Telegram". The existing code returns 200 for everything that really comes from
Telegram (right secret), including strangers and errors. Only requests *without* the right
secret get a 401. That is the safer choice: during setup, if the secret isn't registered
yet, Telegram keeps the message and retries instead of the message being thrown away.
Someone who isn't Telegram learns nothing either way.

**Tests** (`tests/ask-edit-check/telegram-lock.test.mjs`, loads the real file with a fake
Deno and a fake `fetch`): missing secrets → 401 and no calls; wrong / missing header →
401; stranger with the right header → 200 and nothing read or saved; owner → thought saved.
Result: 4 of 4 pass.

**Go-live for the lock** (only needed if it isn't live yet; check with
`npx supabase secrets list --project-ref zqbjxbdborfahsomluye` — if both
`TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_OWNER_ID` are listed and the bot answers you, it's live):
1. Set both secrets first. The old code ignores them, so nothing changes yet.
2. Deploy `telegram-bot` with `--no-verify-jwt`. From now until step 3 your messages get a
   401 and Telegram *holds* them (nothing is lost).
3. Straight away, POST `{"setup": true}` to the function with the
   `X-Telegram-Bot-Api-Secret-Token: <your secret>` header. Expect `{"ok": true}`.
4. Send the bot `/recent`. If you get your thoughts back, it worked and the held
   messages arrive too. If you get nothing within a minute, open
   `https://api.telegram.org/bot<token>/getWebhookInfo` in a browser and read
   `last_error_message` — you'll *know* it's broken, rather than it failing silently.

## 2. Ask mode

**What it does.** You type a question. It searches your thoughts *and* your library with the
same hybrid search the Search tab uses, sends the best matches to the AI, and the AI writes a
short answer using only those notes, with labels like [T1] (a thought) or [L2] (a library
entry). Below the answer you see the notes it used. If nothing matches, or the AI says the notes
don't cover it, you get a plain "Your notes don't cover this yet… I won't guess." With no
matches at all, the AI isn't even called (no cost).

**Files**
- `supabase/functions/_shared/ask.ts` (new): all the logic. No imports, so it's easy to test.
- `supabase/functions/search-brain/index.ts`: new `{ask: true}` option. User comes from the
  login token, like the rest of search-brain.
- `supabase/functions/telegram-bot/index.ts`: new `/ask <question>` command (only works after
  the lock, using `OWNER_USER_ID`). Long replies are split into pieces under Telegram's
  4,096-character limit (max 5 pieces). This splitting now also protects `/search` and
  `/recent`, which used to fail silently on very long thoughts.
- `ask.js` (new) adds an **Ask** button next to Search in Brain → Thoughts → Search.
- `ask-edit-check.css` (new): styles for all three features.
- `index.html`: two lines added before `</body>` (the CSS link and the script).

**Limits (in `ASK_LIMITS`).** Question ≤ 500 characters. Up to 6 thoughts + 4 library
entries. Each note is cut to 1,200 characters (the passage that matched, for long captures).
Everything sent to the AI together ≤ 8,000 characters. Answer ≤ 450 tokens, and cut at 2,000
characters. The prompt tells the AI the notes are data, never instructions.

**Decisions**
- The AI goes through `call-llm` (source `ask` or `telegram-ask`), so spend is tracked as usual.
- If the AI cites no labels, all notes sent are listed (safer than listing none).
- Outdated notes (item 3) are labelled "(outdated)" for the AI and in the list. Before the new
  SQL runs, that check quietly does nothing.

**Tests** (`tests/ask-edit-check/ask.test.mjs`, plus two in `telegram-lock.test.mjs`): no
matches → no AI call; NOT_COVERED → plain message; only cited notes listed; context cap holds
with twenty 250,000-character notes; matched passage used; long answers cut; question cap;
"data, not instructions" in the prompt; outdated labels; failed embedding still answers; AI
failure is an error; Telegram splitting (paragraphs, one giant word, runaway reply);
Telegram `/ask` from the owner uses OWNER_USER_ID and saves nothing; `/ask` from a stranger
does nothing. Result: all pass.

**Not tested:** `search-brain` itself can't be loaded here (it imports supabase-js from the
internet, and Deno couldn't be installed in this cloud computer). The Ask button was checked
in a headless browser with a fake `sb` (see the UI check section further down, if present).

## 3. Edit notes

**What it does.** Every thought card in Brain → Thoughts (Recent and Search results) gets an
**Edit** button. It opens the full text in a box, a "This note is outdated" tick box and, when
ticked, a search to pick the newer note that replaces it. "Earlier versions" shows the text
before each edit; tapping one puts it back in the box (you still press Save). Outdated notes
get an "Outdated" badge.

**How saving works**
1. `edit-thought` (new edge function) takes the user from the login token.
2. It calls `save_thought_edit` (new SQL function), which in **one transaction**: checks the
   thought is yours and not archived, saves the old text + old tags/category/summary to
   `thought_versions`, updates the text (the existing `trg_thoughts_set_dedup_key` trigger
   recalculates `dedup_key`), and clears the embedding, the old 'summary' chunks and the old
   semantic links. If the new text is exactly the same as another of your notes, the unique
   `(dedup_key, user_id)` index refuses it, the whole thing is undone (no version row either),
   and the app shows "Another of your notes already has exactly this text. Nothing was changed."
3. Then it rebuilds embedding → links → chunks → tags/category/summary with the **same code
   enrich-thought uses** (moved into `_shared/enrich.ts`). Short notes are rebuilt before the
   app gets its answer; long ones (over 2,000 characters) in the background.

**If the AI is down during an edit:** the embedding stays empty (it was cleared in step 2), so
`backfill-embeddings` picks it up, and then `backfill-links` links it (it has no links left).
Long notes without chunks show up in `thoughts_needing_chunks` for `backfill-chunks`; chunks
saved without an embedding are fixed by `backfill-chunks {"fill_embeddings": true}`. If tagging
fails, the old tags stay. These are the same repair jobs you already run.

**Outdated notes** (`outdated_at`, optional `replaced_by`):
- `search_thoughts`: same parameters and same result columns, so `create or replace` updates it
  in place. Outdated notes get half their score, so they show up below current notes but are
  never hidden. Ask labels them "(outdated)".
- `find_links_for_thought`: never links to an outdated note. Edited outdated notes aren't linked either.
- `daily-quiz` and `gap-questions`: skip outdated notes.
- Never deleted. Un-ticking the box makes a note current again.
- A replacement must be another of your own, non-archived notes, not the note itself, and not a
  note that already points back to this one (no loops).

**Files**
- `supabase/sql/2026-11-03-ask-edit-check.sql` (new): columns, `thought_versions`
  (RLS on, owner can read, nobody can write from the browser), `save_thought_edit` (service role
  only; old versions dropped first), `search_thoughts`, `find_links_for_thought`.
- `supabase/functions/edit-thought/index.ts` (new).
- `supabase/functions/_shared/enrich.ts` (new, code moved from enrich-thought unchanged),
  `supabase/functions/_shared/thought-edit.ts` (new, the rebuild).
- `supabase/functions/enrich-thought/index.ts`: now imports from `_shared/enrich.ts`. Same
  behaviour; only one log line's wording changed.
- `supabase/functions/daily-quiz/index.ts`, `gap-questions/index.ts`: one line each (`outdated_at is null`).
- `edit-thought.js` (new) and styles in `ask-edit-check.css`; one `<script>` line in `index.html`.
  It hooks into the existing `renderThoughtCards` / `renderSearchResults` the same way
  `shell.js` wraps loaders, so `index.html`'s own code is unchanged.

**Decisions**
- Old links are removed in *both* directions when the text changes (they described the old
  text). Marking a note outdated does *not* remove its existing links; it just gets no new ones.
- `thought_versions` has no delete policy and no cascade, so history is never lost by accident.
- Edits are capped at 200,000 characters.
- I did **not** change `backfill-links`, `weekly-digest` or `open-brain-mcp` (the last two were
  off-limits). See "Changes for later" below.

**Tests**
- `tests/ask-edit-check/sql.test.mjs` runs the *real* 2026-10-22 and 2026-11-03 SQL files in
  PGlite (an in-memory Postgres with pgvector), with a fake `auth.uid()`, an `authenticated`
  role and the course's dedup trigger. Checks: file runs twice; works if the other session
  added the columns first; no extra overloads; edit saves the old version, recalculates
  dedup_key, clears embedding/summary chunks/links but keeps 'source' chunks; duplicate text is
  refused and fully rolled back; same text as *another user's* note is fine; can't edit someone
  else's or an archived thought; outdated + replacement + undo; bad replacements and loops
  refused; owner can read versions, others can't, the browser can't write them or call
  `save_thought_edit`; outdated notes rank lower in `search_thoughts` but are still found;
  `find_links_for_thought` skips them. All pass.
- `tests/ask-edit-check/edit.test.mjs`: the rebuild with a fake database and fake AI:
  embedding + links + tags; outdated note not linked; embedding failure leaves it for the
  backfill; long note re-chunked; digests keep tags; bad AI reply keeps old tags;
  `parseEnrichment` unchanged. All pass.

**Not tested:** `edit-thought/index.ts` and `enrich-thought/index.ts` themselves (they import
supabase-js from the internet; no Deno here). The live `thoughts` table may have columns or
policies my PGlite copy doesn't; the SQL only touches columns named in CLAUDE.md.

## 4. Door check

**What it does.** Whenever outside text comes into the library (a web page via `capture-url`,
a YouTube transcript via `capture-youtube`, a PDF or pasted transcript via `save-library`), it
is checked for wording that tries to give orders to an AI ("ignore all previous instructions",
fake `SYSTEM:` lines, "reveal your hidden instructions", "if you are an AI reading this…",
lots of invisible characters). The result goes on the library row as
`metadata.door_check = { flagged, reasons, checked_at }` (the shared name, exactly).
**The save is never blocked.** In Study → Library, opening a flagged entry shows a "Heads-up"
box under the title with the reasons.

**Cheap first.** Pattern matching runs over the whole text (no AI, no cost; under 2 seconds even
for ~1.5 million characters in the test). Clear matches flag right away. Only when the patterns
are *unclear* (softer hints like "from now on, respond only…" or "you are now an assistant")
does a small sample (the text around those hints, max 3,000 characters) go to the AI through
`call-llm`. Just naming an AI model ("this article compares ChatGPT and Claude") doesn't trigger
an AI call. A whole transcript is never sent.

**Decisions**
- If the AI double-check fails or gives an unreadable answer, the entry is **flagged** (safer:
  a false warning costs nothing, a missed one could matter).
- If the door check itself crashes, it also flags (with reason "door check could not run").
- `save-library` writes `door_check` *after* any metadata the browser sent, so a page can't
  send a fake "not flagged" result.
- An article *about* prompt injection will probably be flagged. That's expected and harmless.
- The capture functions now also return `door_flagged: true/false`; the app ignores it for now.
- Re-capturing the same URL replaces the metadata, so the check is re-done.
- Old library rows have no `door_check` and show no box (nothing to backfill unless you want to).

**Files**
- `supabase/functions/_shared/door-check.ts` (new).
- `capture-url`, `capture-youtube`, `save-library` (`index.ts`): a few lines each.
- `door-flag.js` (new): watches the Library reader (no change to `library.js`) and adds the box.
  Styles in `ask-edit-check.css`; one `<script>` line in `index.html`.

**Tests** (`tests/ask-edit-check/door-check.test.mjs`): clean class notes → not flagged, no AI
call; nine kinds of clear attempts → flagged without AI; invisible characters; naming an AI
model → nothing; unclear text cleared by AI / flagged by AI; AI down, unreadable or throwing →
flagged; a ~1.5-million-character transcript → fast, and the AI sample stays under 3,000
characters; exact result shape; helpers. All pass.

## UI check (headless browser)
`tests/ask-edit-check/ui.test.mjs` loads `ask.js`, `edit-thought.js`, `door-flag.js` and
`ask-edit-check.css` into Chromium on a small copy of the Search / Recent / Library markup with
a **fake** `sb` client (all network blocked). It checks: Ask sends `{query, ask: true}`, shows
the answer as plain text (HTML in an answer is not run), lists notes with the Outdated tag; cards
get Edit buttons and Outdated badges; the editor loads the text, shows earlier versions, lets
you tick outdated, find and pick a replacement, and sends exactly
`{id, content, outdated, replaced_by}`; the door flag shows for a flagged entry and not for a
clean one; no page errors. I also looked at a phone-width screenshot with the app's real styles.
Not checked: the real `index.html` with real sign-in (needs the live Supabase).

## Changes for later (files I wasn't allowed to touch)
- `open-brain-mcp`: `search_thoughts` there already ranks outdated notes lower (it's the SQL).
  Its `list_recent` could show "(outdated)" and its `search_library` path could show the door
  check flag. Optional.
- `weekly-digest`: add `.is("outdated_at", null)` to its thoughts query if you don't want
  outdated notes in the Sunday summary.
- `backfill-links`: optional `.is("outdated_at", null)` so it doesn't give an outdated note
  new outgoing links.
- `sw.js`: add the new app files to the `SHELL` list (see go-live steps).
