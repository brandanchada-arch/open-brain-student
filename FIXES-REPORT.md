# Go-live fixes report

Branch: **`cloud/go-live-fixes`**, made from `origin/cloud/merge-rehearsal` (commit `1a8222c`).
Nothing was pushed to master, no other branch was changed, nothing was deployed, and no live service was contacted.

## Baseline (before any fix)
- `npm install`: OK.
- `npm run check`: **Check passed**. JS syntax 44 files; Deno not installed here (type-check skipped);
  tests: 109 passed in 14 files; SQL: 4 of 4 files load, 3 re-run.

## Fixes
(Filled in as each fix is committed. Go-live changes are collected in the last section.)

| # | Fix | Status |
|---|---|---|
| 1 | Forged service tokens (`weekly-digest`, `daily-quiz`, `gap-questions`, `weekly-condenser`) | **done**, commit `67ba821` |
| 2 | Today page shows the morning summary | **done**, commit `c0d5e58` |
| 3 | Ask skips door-flagged library entries (P6) | **done**, commit `6c22c7d` |
| 4 | Backup keeps `library_links` (P7) | **done**, commit `d458cd9` |

---

## Fix 1: made-up service tokens (P3 and the same hole in three more functions)

### What it does, in plain words
Four functions decide "is this my own scheduler calling?" with a little check called `isServiceCaller`.
The old check only **read** the word written inside the caller's token (`"role": "service_role"`). It never
checked the token's signature, which is the part that proves Supabase made it. Anyone can write that word, so
anyone could pretend to be your scheduler.

The four copies are replaced by one shared file, `supabase/functions/_shared/service-caller.ts`. A caller now
counts as your scheduler only if:
1. the token is **exactly** your `SUPABASE_SERVICE_ROLE_KEY` (the function already has it), or
2. the token says `service_role` **and Supabase's own login service (Auth) accepts it** for an admin-only,
   read-only request (`GET /auth/v1/admin/users?per_page=1`; the answer is thrown away). Auth checks the
   signature with the project's real signing secret. This code never needs that secret, so I did **not**
   assume a signing secret is available to the functions (as far as I know, Supabase doesn't give them one).

Step 2 is there only so the live Sunday job can't break if the token it sends is a genuine service-role token
that isn't letter-for-letter your key (I can't see what it sends; see "What I couldn't find out" below).
If Auth can't be reached, or `SUPABASE_ANON_KEY` is missing, step 2 says "no", so a mistake fails closed.
App users' login tokens say `"authenticated"`, never reach step 2, and go on to the normal "is this the owner?"
check exactly as before. `call-llm` calls from these functions are unchanged (they send the exact key).

`config.toml` is **unchanged** (`weekly-digest` keeps `verify_jwt = false`). Turning Supabase's front-door check
on for it would be a second lock, but it could stop the Sunday job if its token isn't a JWT Supabase's gateway
accepts, and I can't see that token. The code fix alone closes the hole. Optional later: turn it on, then repeat
the go-live test run below.

### What a made-up token could do before the fix (read from the code, not tried live)
| Function | Front-door check | What a made-up token set off | What came back to the attacker |
|---|---|---|---|
| `weekly-digest` | off (`config.toml` `verify_jwt = false`) | Reads **every** non-archived thought from the last 7 days (no user filter; this is a one-person project), sends them to the AI through `call-llm` (AI cost), then **saves or overwrites this week's digest** in your library and re-embeds it (more cost). Repeatable as often as they like. | Only `{"ok":true,"digestId":…,"thoughtCount":N}` or `{"skipped":true,"note":"Only N thoughts…"}`. **No note text and no digest text.** An error reply could include `call-llm`'s error JSON (an error message, not your notes). |
| `daily-quiz` | off (`--no-verify-jwt`) | **Service mode** (around line 83). The request body is ignored. Reads your class notes from the last 14 days plus recent library notes, sends them to the AI (cost), and **sends a 3-question quiz to your own Telegram chat** (`OWNER_TELEGRAM_CHAT_ID`, or `planner_chat_id` from `bc_settings`). The attacker can't choose the chat. Repeatable, so they could spam your Telegram and run up AI cost. | Only `{"ok":true,"sent":3,"notesUsed":N}` or "No class notes in the last 14 days". **The questions themselves go only to your Telegram**; JSON with questions is only returned in app mode, which needs your real login. Small leak: how many class notes you saved recently. |
| `gap-questions` | off (`--no-verify-jwt`) | **Service mode** (around line 89). Reads your last 30 days of thoughts, sends up to 30,000 characters of them to the AI, and **sends 3 "gap" questions to your Telegram**. Same spam and cost risk. | Only `{"ok":true,"sent":true,"thoughtCount":N}` or "Only N thoughts in 30 days". **Nothing made from your notes.** Small leak: how many thoughts you saved in 30 days. |
| `weekly-condenser` (new) | **on** (deployed without `--no-verify-jwt`) | Nothing: Supabase's front door rejects a bad signature before the code runs. If someone ever deployed it with `--no-verify-jwt`, a made-up token could make it write **proposals** (never page changes) and cost AI money. | Counts only. |

So: before the fix, a made-up token **could not get any of your note text back**, but it could make three functions
read your notes, send them to the AI provider (the same one they normally go to), spend your AI credit, overwrite
this week's digest, and send quiz/gap messages to your own Telegram whenever it liked.

### How each function is called (what I could and couldn't find)
Searched `supabase/`, `.github/`, `curriculum/`, the notes files and `pc-setup/`.
- `weekly-digest`: pg_cron. The course (`curriculum/Level-5-Agents.md` step 6) set it up as job `weekly-brain-digest`
  sending **no** Authorization header. The function's comment says the live job sends a service_role token from Vault,
  so the job was probably changed later. **Can't determine** what the live job sends. If it sends no header at all, it is
  already refused today (the old check refused a missing token too), so the fix changes nothing for it.
- `daily-quiz`, `gap-questions`: CLAUDE.md says "also Telegram via the scheduler". The scheduler isn't in this repo
  (it may be a pg_cron job or something in the private Brain Calendar code). **Can't determine** which token it sends.
- `weekly-condenser`: not scheduled yet (`2026-11-03-core-memory.sql` section 8 is commented out); it will send the
  Vault secret, which the instructions say should be the service role key.
- `.github/workflows/keep-alive.yml` only reads one row through the REST API with the public key. It calls no function.
- Inside the repo, these four functions are never called by other functions.
Because of these unknowns the fix accepts any **genuine** service-role token (step 2), and the go-live list has a
test run of each scheduled job before you rely on it.

### Tests (`tests/go-live-fixes/service-caller.test.mjs`, 27 tests, all made-up tokens and fakes)
Each of the 4 real function files is loaded in Node with a fake Deno, a fake supabase-js and a fake network:
- two made-up tokens (the one from the rehearsal report, and a properly formed one signed with the wrong secret)
  → **401**, no table read, no AI call, no Telegram message (all 4 functions);
- no token → 401 without any network call;
- the exact service key → service mode (reads thoughts, never treated as an app user, no Auth call);
- a genuine-but-different service token (fake Auth says yes, like a Vault copy) → service mode;
- Auth unreachable, or `SUPABASE_ANON_KEY` missing → only the exact key works;
- `daily-quiz` / `gap-questions`: your app login stays in **app mode** (JSON back, nothing to Telegram, no admin
  check); someone else's login → 401; a made-up token with `{course}` gets exactly `{"error":"Unauthorized"}`.
**Proof the tests catch the hole:** with the old four files put back, 11 of the 27 tests fail; with the fix, 27 of 27 pass.
`tests/core-memory/condenser.test.mjs` had a text check for the old line `if (!isServiceCaller(req))`; it now
checks for `if (!(await isServiceCaller(req)))` and the shared import (same meaning).

### Redeploy list for fix 1 (from the `open-brain-student` folder, `<ref>` = your project ref)
| Function | Command flags | Was it already in the go-live list? |
|---|---|---|
| `weekly-condenser` | none (**never** `--no-verify-jwt`) | yes, 4b |
| `daily-quiz` | `--no-verify-jwt` | yes, 4g |
| `gap-questions` | `--no-verify-jwt` | yes, 4g |
| `weekly-digest` | none (`config.toml` keeps `verify_jwt = false` for it) | **no, added as 4k** |
No other function imports `_shared/service-caller.ts`.

### Undo (one line each)
`cd ..\ob-master; npx supabase functions deploy weekly-digest --project-ref <ref>` (same for `daily-quiz` and
`gap-questions`, adding `--no-verify-jwt`). That puts back master's version, which has the old check but works with
the schedule exactly as today. `weekly-condenser` is new: undo it as in the rehearsal list (delete it).

---

## Fix 2: the Today page shows the morning summary

### What it does, in plain words
Each time the Today tab loads, `planner.js` now also asks `bc-calendar` for `{action: "summary"}` (through the same
`api` helper the page already uses). A new box (`<div id="plannerSummary">` in `index.html`, between the
notifications line and "Waiting for your OK") shows:
- **Morning summary** with its time, and the summary text (line breaks kept, cut at 1,500 characters);
- **Still waiting**: up to 8 items, each with its text (cut at 200 characters), a small chip for `kind`, and the time.

When the summary is already delivered (`delivered: true`) and nothing is waiting, it's folded into a small grey
"Morning summary · 7:00 AM" line you can tap to open, the same style as "Notifications: on".
If the call fails, an older `bc-calendar` answers with an error, the reply isn't `ok: true`, or there is nothing to
show, the box stays **empty**: no error message. Every piece of outside text (summary, waiting text, kind, time)
goes through the page's existing `esc`, so email subjects can't add HTML or run code.
The drawing is a small function, `plannerSummaryHtml`, exported like the other planner helpers so it can be tested.
`bc-calendar` itself was not touched (it's in the private repo).

`sw.js`: `VERSION` bumped once, `ob-2026-11-04-merge1` → `ob-2026-11-04-fixes1`, so phones pick up the new
`planner.js` and `index.html`. No file was added to `SHELL`. This is the only bump on this branch.

### Tests (`tests/go-live-fixes/morning-summary.test.mjs`, 8 tests)
- summary + waiting list shown; delivered + nothing waiting → folded `<details>`; delivered + something waiting → open;
  no summary but waiting items → just the list;
- 14 bad or empty replies (error object, older version's `{error: "Unknown action"}`, `ok:false`, no summary, blank
  text, wrong types…) → nothing at all;
- made-up `<script>alert(1)</script>` and `<img src=x onerror="alert(2)">` in the text, kind and time stay text,
  using the page's real `esc` (read out of `planner.js`, so the test follows any change to it);
- in headless Chromium: that HTML creates no `<script>`/`<img>` elements and no alert;
- in headless Chromium, the **real `planner.js`** on the **real Today markup** from `index.html` with a fake `sb`:
  it calls `bc-calendar` with `{action: "summary"}` and shows the box; with an error reply or a thrown error the
  box is empty, there are no page errors, and no error note appears.
I also took a phone-size screenshot with the page's own styles to check it looks like the rest of Today (not committed).

---

## Fix 3: Ask leaves out library entries the door check flagged (P6)

### What it does, in plain words
When you save a web page, video or PDF, the "door check" looks for text trying to boss the AI around and, if it
finds some, marks the entry (`metadata.door_check.flagged = true`). The weekly condenser already ignores those
entries; Ask didn't. Now Ask doesn't either.

One catch: the library search (`search_library`) doesn't return `metadata`, so Ask can't see the mark in the search
results. Rather than change the SQL, Ask now asks the database "which of these library entries are flagged?"
(only your own rows: `user_id` = the signed-in user, or `OWNER_USER_ID` for Telegram) and drops those before
anything goes to the AI. `buildContext` also drops any row that carries the mark itself, before counting, so a
flagged entry doesn't take a clean entry's place.
**Safer choice:** if that lookup fails, Ask leaves the **whole library** out for that question (thoughts are still
used) instead of risking a flagged entry. If nothing is left, the answer is the normal
"Your notes don't cover this yet…" and the AI isn't called at all.
Changed: `supabase/functions/_shared/ask.ts` (used by `search-brain` and `telegram-bot`) and the small database
helper in `telegram-bot/index.ts`. `tests/ask-edit-check/ask.test.mjs`'s fake now says "nothing flagged" (one line),
because without the lookup Ask now leaves the library out.

### Tests (`tests/go-live-fixes/ask-flagged.test.mjs`, 8 tests)
- a flagged entry found by the lookup isn't in the prompt; the clean one is, and is the only source;
- only flagged matches → "notes don't cover this", AI never called;
- a row carrying its own flag is dropped by `buildContext`, and flagged rows don't use up the 4 library slots;
- lookup throws, or isn't provided → library left out, thoughts still used;
- no library hits → no lookup made;
- `search-brain`'s lookup reads `library` filtered by `user_id`, reads the flag from `metadata`, and throws on error;
- the real `telegram-bot` `/ask` with a flagged hit: the lookup URL has `user_id=eq.<owner>`, the AI is never
  called, and the reply says the notes don't cover it.
With the old `ask.ts` and `telegram-bot` put back, 7 of these 8 fail.
`search-brain`, `telegram-bot` and `export-brain` also type-check with Deno when esm.sh is pointed at the npm copy
of supabase-js (esm.sh can't be reached from here).

### Redeploy for fix 3
`search-brain` (flags: none) and `telegram-bot` (`--no-verify-jwt`). Both are already in the go-live list (4e, 4h);
nothing new to add. Extra check after 4e: Ask still answers a question you know is in your notes.
Undo: as in the list (redeploy from the master copy).

---

## Fix 4: the backup keeps library links (P7)

### What it does, in plain words
`library_links` records "this takeaway thought came from that library entry". The search jobs can rebuild
embeddings, chunks and thought links, but **nothing can rebuild these**, so they need to be in the backup.
- `export-brain` now accepts `{"table": "library_links"}`. That table has no `id` and no `user_id` of its own,
  so it can't be paged and filtered the same way as the others. Instead each page takes the next batch of
  **your** library entries (`library` filtered by `user_id = OWNER_USER_ID`, ordered by id — the same rule as the
  table's own RLS policy) and returns every link pointing at them. The cursor is the last library id, so all links
  of one entry always come together and none are skipped. A page can be empty and still not be the last
  (an entry with no links). Read-only: it only runs selects. Page size limits are the same (1–50).
- `pc-setup/scripts/weekly-export.js` downloads them and adds `library_links` (and `counts.library_links`) to the
  backup JSON; `--check` also tests them. The backup `version` stays 1 (one key added).
  **Safer choice:** if the PC talks to an older `export-brain` that doesn't know `library_links`, the backup is still
  written, with `library_links: null`, and the log says `WARNING: library_links were NOT backed up … Redeploy
  export-brain`. Any other error still stops the run, as before.
- `pc-setup/tests/fake-supabase.mjs` gained `.in()` (one line), `pc-setup/README.md` mentions `OK library_links` in
  the `--check` output, and `pc-setup/NOTES.md` no longer lists `library_links` as "not exported".

### Tests (`pc-setup/tests/library-links.test.mjs`, 5 tests, existing fakes)
- the real handler with page sizes 1, 2, 3 and 50: exactly your 5 links (3 on one entry), none from someone
  else's entry, only `thought_id`, `library_id`, `note`, `created_at`; with page size 1 an empty page is not the end;
- every page reads `library` with `user_id` and `library_links` with `in(library_id)`; the fake refuses writes;
- a bad cursor → 400;
- the real PC script against the fake server: the backup has `library_links` (5) and its count, no other
  person's link, no user id; `--check` prints `OK library_links`;
- against a fake "older" export-brain: the run still succeeds, writes `library_links: null`, and warns.
With the old handler and script put back, all 5 fail.

### Redeploy for fix 4
`export-brain` (`--no-verify-jwt`). Already step 4j (new in this go-live, undo = delete). Extra check after 4j:
POST `{"table":"library_links"}` with the right key → `200` and `{"table":"library_links",…}`. The PC script is
copied in step 7 as before (`pc-setup/README.md`); its `--check` should now also print `OK library_links`.

---

## Changes to REHEARSAL-REPORT.md's go-live list (already made there, marked **(fixes)**)
1. Top of the list, steps 0, 1 and 5: use **`cloud/go-live-fixes`** instead of `cloud/merge-rehearsal`.
2. Step 3: also check `SUPABASE_ANON_KEY` is listed in secrets (fix 1's Auth check needs it).
3. **New step 3b** (read-only): list the pg_cron jobs and whether each sends a token / uses Vault, without printing the command.
4. Step 4b `weekly-condenser`: unchanged flags (none, never `--no-verify-jwt`); now includes fix 1.
5. Step 4g `daily-quiz`, `gap-questions`: same flags (`--no-verify-jwt`), two extra checks: made-up token → 401 with
   no Telegram message; real service key → quiz arrives. Undo: redeploy from `..\ob-master` with `--no-verify-jwt`.
6. **New step 4k `weekly-digest`**: flags none. Checks: made-up token → 401; then the **go-live test run** of every
   scheduled job found in 3b (run the job's own command once from the SQL Editor; the logs must not show 401).
   Undo: `cd ..\ob-master; npx supabase functions deploy weekly-digest --project-ref <ref>`.
7. The "don't need a redeploy" line no longer lists `weekly-digest`.
8. Step 6 (condenser schedule): test-run the job once the same way.
9. Step 9 (paperwork): add the CLAUDE.md lines suggested below.
11. Step 5 (fix 2): `sw.js` is now `VERSION = 'ob-2026-11-04-fixes1'`. Extra phone check: Today shows the morning
    summary (or nothing, if `bc-calendar` doesn't know `summary` yet). No deploy step: it's part of the app merge.
12. Steps 4e `search-brain` and 4h `telegram-bot` now also carry fix 3 (same flags). Extra check after 4e: **Ask**
    still answers a question you know your notes cover. No new deploy step.
13. Step 4j `export-brain` now carries fix 4 (same flag `--no-verify-jwt`). Extra check: `{"table":"library_links"}`
    with the right key → 200. Step 7: the PC `--check` also prints `OK library_links`.
14. P6 and P7 in the problem table are marked fixed on this branch.
10. P3 in the problem table is marked fixed on this branch.

## Suggested lines for CLAUDE.md (not edited, as instructed)
- In the edge-function table: `| _shared/service-caller.ts | isServiceCaller for scheduler-only paths: exact SUPABASE_SERVICE_ROLE_KEY, or a token Supabase Auth accepts as admin. Never decode a token's role without checking it |`
- In "Deploying", add `weekly-digest`, `daily-quiz`, `gap-questions` and `weekly-condenser` to "Anything importing `_shared/` must be redeployed…" (weekly-condenser is new).
- Gotcha: **Reading a JWT's `role` proves nothing.** Functions with `verify_jwt = false` / `--no-verify-jwt` must check the
  token itself (`_shared/service-caller.ts`). (2026-11-04)

---

## Final test results (this branch, Linux, Node 22.23)
| What | Result |
|---|---|
| `npm install` | OK |
| `npm run check` (no Deno) | **Check passed**: JS syntax 49 files + 1 inline script; tests **157 passed in 18 files**; SQL 4 of 4 load, 3 re-run |
| `npm run check` with Deno 2.5.6 (from npm, in a scratch folder) | **Check passed**: 13 of 20 function folders type-check; the other 7 import esm.sh, which this computer can't reach |
| Those 7 with esm.sh pointed at the npm copy of supabase-js (scratch import map, repo unchanged) | all 7 type-check, so 20 of 20 |
| `tests/core-memory/` | 36 pass, 0 fail |
| `tests/ask-edit-check/` (incl. the headless-browser UI test, which ran) | 53 pass, 0 fail |
| `tests/go-live-fixes/` (new: fixes 1–3, incl. 2 headless-browser tests, which ran) | 43 pass, 0 fail |
| `pc-setup/tests/` (`node --experimental-strip-types --test pc-setup/tests/*.test.mjs`) | 25 pass, 0 fail (20 old + 5 new) |
| New tests against the old code | fix 1: 11 of 27 fail; fix 3: 7 of 8 fail; fix 4: 5 of 5 fail (fix 2's tests need the new function, so they can't load against the old file) |

## What couldn't be tested here
- **Supabase Auth's real answer** to fix 1's admin check (`GET /auth/v1/admin/users?per_page=1`). The tests fake
  it. Go-live step 4k's test run of the real scheduled job is the check. The exact-key path needs no Auth call.
- **What token the live Sunday digest job and the quiz/gaps scheduler send** (not in this repo; step 3b finds out
  without printing keys), and whether the Vault secret is identical to `SUPABASE_SERVICE_ROLE_KEY`.
- Whether `SUPABASE_ANON_KEY` is present in the live function environment (Supabase normally provides it; step 3).
- **`bc-calendar`'s real `summary` reply** (private repo). The page was tested against the shape given in the task
  and against error replies. Not tried on a real phone.
- PostgREST's handling of the export's `.in("library_id", …)` with up to 50 ids, and the two `.order()` calls,
  on the real database (the fake database stands in).
- Real deploys, the live database, Telegram, real AI answers, Vercel, Windows Task Scheduler (as in the rehearsal).

---

Branch: **`cloud/go-live-fixes`** (pushed; the environment accepted this name). Nothing was pushed to master and
no other branch was changed.
