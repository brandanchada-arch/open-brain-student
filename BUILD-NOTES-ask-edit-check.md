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
| 3 | Edit notes | not started |
| 4 | Door check | not started |

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
