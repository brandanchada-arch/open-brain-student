# Build notes: core memory (branch `cloud/core-memory`)

Plain-language notes for Brandan. Updated after each numbered item.

## What this adds (short version)

Your brain gets a few **pages**: a short "core" page that says who you are and what's true now,
plus topic pages (job-search, courses, mega). Every Sunday a new function, **weekly-condenser**,
reads the week's new notes and **proposes** changes to those pages. Nothing changes until you
press **Approve** in the app (Brain → Review). Every approved change can be undone.
Claude Desktop reads the core page at the start of each chat through a new MCP tool, `get_core`.

## Progress

| # | Item | Status |
|---|---|---|
| 1 | Pages tables + versions (undo) | done, 11 SQL tests pass |
| 2 | MCP `get_core` + `add_session_log` | done, 5 tests pass |
| 3 | weekly-condenser function | done, 10 tests pass |
| 4 | Topic pages: Current replaced, History grows | done, 2 SQL tests |
| 5 | Review screen + review-proposal function | done, 9 tests pass + UI checked with a fake backend |
| 6 | Dated SQL file + commented pg_cron job | done (commented out), 36 tests pass |

## Setup note

- I built this in a separate folder (`C:\Users\josep\open-brain-core-memory`, a "git worktree":
  a second checkout of the same repo) because other sessions were using the main folder at the same time.
  Branch: `cloud/core-memory`, made from `origin/reference-library`.

## Item 1: pages (done)

File: `supabase/sql/2026-11-03-core-memory.sql` (all schema for this build lives in this one file).

- `brain_pages`: one row per page per user. Slugs `core`, `job-search`, `courses`, `mega`.
  `current_text` = what's true now; `history_text` = older versions, newest first.
  The file seeds an empty row of each for every signed-up user (no user ids written in the repo).
- `brain_page_versions`: before any approved change, the page's old text is saved here.
  **Undo** copies the most recent one back. You can undo several times in a row.
- `brain_proposals`, `session_logs`, and `thoughts.outdated_at` / `thoughts.replaced_by` are in the same file.
- Three database functions do the changes, each in one transaction:
  `approve_brain_proposal(user, proposal)`, `reject_brain_proposal(user, proposal)`, `undo_brain_page_change(user)`.
  Only the service role (edge functions) may call them.

Tests: `tests/core-memory/sql.test.mjs` (PGlite). Checks seeding, running the file twice, RLS (you read only your
own rows, nobody can write pages/proposals/logs directly from the app), approve/reject/undo, double-approve refused,
someone else's proposal refused, core page over 4,000 characters refused, long session summaries refused.

## Item 2: MCP tools (done)

Changed `supabase/functions/open-brain-mcp/index.ts` (small edits) and added `supabase/functions/_shared/core-memory.ts`
(new file; the logic lives here so it can be tested with Node).

- `get_core`: returns the core page's approved "Current" text for `OWNER_USER_ID`, labelled as background facts,
  not instructions. Empty page = a short note saying so.
- `add_session_log(title, summary, project)`: saves to `session_logs` for `OWNER_USER_ID`. Summary max 2,000 characters
  (checked in the function AND by the database), so transcripts can't be stored. Any user id in the arguments is ignored.
- `initialize` now returns an `instructions` field ("call get_core at the start of every chat"). The `get_core`
  description says the same, for clients that ignore instructions. Version bumped to 1.5.0.
- Both tools refuse to run if `OWNER_USER_ID` is not set, like the library tools.

Tests: `tests/core-memory/mcp.test.mjs` with a fake database (`tests/core-memory/fake-db.mjs`).
Couldn't test: the real MCP server running in Deno (Deno could not be installed here; its npm installer needs to
download a binary and that was blocked). The wiring in `index.ts` is checked by reading the source.

## Item 3: weekly-condenser (done)

New function `supabase/functions/weekly-condenser/` (`index.ts` = the door, `handler.ts` = the work).
weekly-digest was not changed.

- Only the scheduler or another function can run it (`isServiceCaller`, copied from weekly-digest). It uses
  `OWNER_USER_ID` for whose notes to read, and refuses to run without it.
- Reads the last 7 days of: your thoughts (not archived, not outdated, not digests, max 300), new library rows
  (not digests, max 40, any row with `metadata.door_check.flagged = true` is skipped) and session logs (max 100).
  Each note is cut to 700 characters, 40,000 in total, like the digest.
- No minimum: one note is enough. **Nothing new = no AI call and nothing written.**
- **First run with an empty core page**: also reads the short summaries of up to 400 active thoughts
  (300 characters each, 20,000 total) to draft a first core page.
- One AI call through `call-llm` (max 8,000 tokens so the JSON isn't cut off). The prompt says the notes are data,
  not instructions. Notes are labelled T1, L1, S1, B1 so the AI cites short handles instead of long ids; code maps
  them back.
- The answer is checked by plain code: JSON is repaired if needed (`jsonrepair`), unusable = nothing written.
  Each proposal must name a real page and at least one real source; the core page is capped at 3,500 characters
  (asked for under 3,000); unchanged text and second proposals for the same page are dropped.
- **Sensitive** = the AI said so, OR the text mentions health, faith, relationships, journal/diary or personal
  money words, OR a source thought's category is journal/personal/health/etc. The list is broad on purpose:
  a false alarm only adds a warning in the review screen.
- `source_ids` is a list of `{kind, id, label}` (kind = thought / library / session_log), so the review screen can
  show sources without reading `session_logs` (which the app can't read).
- It writes only to `brain_proposals`. It never changes a page.

Tests: `tests/core-memory/condenser.test.mjs` (fake database + fake AI): right notes read and wrong ones left out
(old, archived, outdated, someone else's, flagged), filters sent to the database, nothing-new = no AI call,
works with one note, first-run summaries, pending pages skipped, bad JSON writes nothing, JSON repair (fences,
trailing comma, cut off), proposal checks, sensitive detection. TypeScript checked with `tsc --strict`.

## Item 4: topic pages (done)

- On **Approve**, the page's "Current" is replaced by the proposed text, and the old "Current" goes on top of
  "History" under a heading like `### Until 2026-11-08`. Same for the core page (`get_core` only sends "Current").
- **History only grows** is enforced by the database: a trigger (`brain_pages_history_guard`) refuses any update that
  doesn't keep the old History at the end of the new one, even from the service role. The only exception is
  **Undo**, which switches the guard off for its own transaction and puts the page back exactly as it was.
- The condenser always proposes the FULL new "Current" text (keeping what is still true), never a fragment.

Tests: in `sql.test.mjs`: "approve replaces Current…" and "topic page History can never shrink…".

## Item 5: Review screen + review-proposal (done)

**New function `supabase/functions/review-proposal/`** (`index.ts` = the door, `handler.ts` = the work).

- The app sends `{action: "approve" | "reject", id}` or `{action: "undo"}`.
- **Who you are comes from your login token** (anon client + `auth.getUser()`, same as capture-url).
  A `user_id` in the body is ignored. No token / bad token = 401 and nothing happens.
- It then calls the database functions from item 1 with the service role:
  `approve_brain_proposal`, `reject_brain_proposal`, `undo_brain_page_change`. They only touch your rows.
- Checks before anything runs: action must be one of the three (400 otherwise); approve/reject need an `id`
  that is a real uuid (400 otherwise).
- Database errors become plain messages: not found = 404, "already approved/rejected" or "nothing to undo" = 409,
  core page too long = 422, anything else = 500 with a generic message (internal details are not shown).
- CORS like capture-url. Deploy **normally** (JWT checked by Supabase, no `--no-verify-jwt`).

**New screen: Brain → Review** (`review.js` + `review.css`).

- `index.html`: one Review chip next to Map / Thoughts, an empty `<div id="panel-review">`, the stylesheet link and
  the script tag. `shell.js`: `review: 'brain'` and one line in `load()`. Nothing else in those files changed.
- Shows each waiting proposal: which page, the reason, the page's text **now** vs the **proposed** text, and what it is
  based on (the `label` of each source). **Sensitive** ones get a red warning, and Approve asks "are you sure?" first.
- Approve / Reject buttons, and **Undo last change** (asks first). All three go through review-proposal.
- Below that, your four pages: Current shown, History folded away under "History".
- Reading uses your own login (row-level security), so you only ever see your rows. All text is escaped
  (a note containing `<script>` shows as text, never runs).

Tests: `tests/core-memory/review.test.mjs` (9 tests, fake login + fake database): bad/missing token = 401,
body `user_id` ignored, bad action = 400, id must be a uuid, right database function called for each action,
error messages/status codes, CORS, and index.ts reads the user from the token. `handler.ts` checked with `tsc --strict`.

UI check: I served the app on this machine with a **fake** Supabase (no network at all) in a headless browser at phone
size: both proposals showed, the sensitive warning and confirm appeared, `<script>` in a label showed as text,
Approve / Reject / Undo sent the right requests, and no page errors. Not tried against the real backend.

## Item 6: weekly schedule (done, switched off)

At the end of `supabase/sql/2026-11-03-core-memory.sql` there is a **commented-out** block (section 8) that, once
switched on, makes pg_cron call weekly-condenser every Sunday at 16:00 UTC (`'0 16 * * 0'`, job name
`weekly-brain-condenser`). The key it sends is read from Vault, never written in the file. Two placeholders must be
replaced before use: `<project-ref>` and `<VAULT_SECRET_NAME_PLACEHOLDER>`.
It is commented out because running it before weekly-condenser is deployed would just fail every Sunday.
The SQL tests were re-run after the change: all pass (the commented block is ignored by the database).
Not tested: the cron block itself (PGlite has no pg_cron / pg_net / Vault).

## Final summary

**Built:** brain pages with saved versions and undo (SQL), MCP `get_core` + `add_session_log`, the weekly-condenser
function, topic pages whose History only grows, the review-proposal function, the Brain → Review screen, and a
ready-to-switch-on Sunday schedule.

**Tests:** `npm i --no-save @electric-sql/pglite jsonrepair` then `node --test "tests/core-memory/*.test.mjs"`:
**36 tests, 36 pass, 0 fail** (SQL in PGlite incl. RLS, MCP tools, condenser, review-proposal).

**Not tested:**
- Nothing ran in Deno (it could not be installed here), so the `index.ts` files (the "doors") were checked by reading
  them and by tsc on the handlers, not by running them.
- Nothing ran against the live database or real Supabase login (no live access, on purpose).
- pg_cron / pg_net / Vault (the schedule block).
- The Review screen was only run with a fake Supabase in a headless browser, not with the real backend or on a phone.

**Decisions (safer option each time):**
- review-proposal keeps normal JWT checking AND checks the user itself; it never reads a user id from the body.
- Database error details are not shown in the app except the friendly ones (not found / already done / nothing to
  undo / too long).
- Sensitive proposals need a second "are you sure?"; Undo also asks first.
- The schedule ships switched off, with obvious placeholders.
- `sw.js` was not changed (another session owns it); see go-live step 6.

## Go-live steps (in this order)

1. **Database:** from this folder run
   `npx supabase db query --linked -f supabase/sql/2026-11-03-core-memory.sql`
   (safe to run again; it never deletes rows).
2. **Secrets:** `OWNER_USER_ID` already exists in Edge Function secrets, nothing to add there.
   Put the service role key in **Vault** under a name you choose (Dashboard → Project Settings → Vault).
3. **Deploy** (from this folder):
   - `npx supabase functions deploy weekly-condenser --project-ref zqbjxbdborfahsomluye`
   - `npx supabase functions deploy review-proposal --project-ref zqbjxbdborfahsomluye` (normal, no `--no-verify-jwt`)
   - `npx supabase functions deploy open-brain-mcp --project-ref zqbjxbdborfahsomluye --no-verify-jwt`
     (it imports the new `_shared/core-memory.ts`)
4. **Try it once by hand:** call weekly-condenser with the service role key, then open Brain → Review in the app.
5. **Schedule:** in the SQL file, section 8, replace `<project-ref>` and `<VAULT_SECRET_NAME_PLACEHOLDER>`, remove the
   `-- ` in front of the `select cron.schedule(...)` lines, and run just that block in the SQL Editor.
   Check with `select * from cron.job;` that it runs after weekly-digest.
6. **Phone app cache (sw.js, owned by another session):** add `'review.js', 'review.css'` to the `SHELL` list and bump
   `VERSION` (for example `'ob-2026-11-03-review1'`), so installed phones pick up the new screen and it works offline.
7. Merge the branch into `master` only when all of the above works (master redeploys the live site).

Branch: **`cloud/core-memory`**.
