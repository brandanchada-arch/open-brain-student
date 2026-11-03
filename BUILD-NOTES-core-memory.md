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
| 1 | Pages tables + versions (undo) | in progress |
| 2 | MCP `get_core` + `add_session_log` | not started |
| 3 | weekly-condenser function | not started |
| 4 | Topic pages: Current replaced, History grows | not started |
| 5 | Review screen + review-proposal function | not started |
| 6 | Dated SQL file + commented pg_cron job | not started |

## Setup note

- I built this in a separate folder (`C:\Users\josep\open-brain-core-memory`, a "git worktree":
  a second checkout of the same repo) because other sessions were using the main folder at the same time.
  Branch: `cloud/core-memory`, made from `origin/reference-library`.
