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
| 2 | Today page shows the morning summary | not started |
| 3 | Ask skips door-flagged library entries (P6) | not started |
| 4 | Backup keeps `library_links` (P7) | not started |

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
10. P3 in the problem table is marked fixed on this branch.

## Suggested lines for CLAUDE.md (not edited, as instructed)
- In the edge-function table: `| _shared/service-caller.ts | isServiceCaller for scheduler-only paths: exact SUPABASE_SERVICE_ROLE_KEY, or a token Supabase Auth accepts as admin. Never decode a token's role without checking it |`
- In "Deploying", add `weekly-digest`, `daily-quiz`, `gap-questions` and `weekly-condenser` to "Anything importing `_shared/` must be redeployed…" (weekly-condenser is new).
- Gotcha: **Reading a JWT's `role` proves nothing.** Functions with `verify_jwt = false` / `--no-verify-jwt` must check the
  token itself (`_shared/service-caller.ts`). (2026-11-04)
