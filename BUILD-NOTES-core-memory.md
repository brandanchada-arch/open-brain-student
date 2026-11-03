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
| 3 | weekly-condenser function | in progress |
| 4 | Topic pages: Current replaced, History grows | not started |
| 5 | Review screen + review-proposal function | not started |
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
