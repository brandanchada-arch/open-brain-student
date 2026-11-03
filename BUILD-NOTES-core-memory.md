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
| 5 | Review screen + review-proposal function | in progress |
| 6 | Dated SQL file + commented pg_cron job | not started |

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
