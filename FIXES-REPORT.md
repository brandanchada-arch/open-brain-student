# Go-live fixes report

Branch: **`cloud/go-live-fixes`**, made from `origin/cloud/merge-rehearsal` (commit `1a8222c`).
Nothing was pushed to master, no other branch was changed, nothing was deployed, and no live service was contacted.

## Baseline (before any fix)
- `npm install`: OK.
- `npm run check`: **Check passed**. JS syntax 44 files; Deno not installed here (type-check skipped);
  tests: 109 passed in 14 files; SQL: 4 of 4 files load, 3 re-run.

## Fixes
(Filled in as each fix is committed.)

| # | Fix | Status |
|---|---|---|
| 1 | Forged service tokens (`weekly-digest`, `daily-quiz`, `gap-questions`, `weekly-condenser`) | in progress |
| 2 | Today page shows the morning summary | not started |
| 3 | Ask skips door-flagged library entries (P6) | not started |
| 4 | Backup keeps `library_links` (P7) | not started |
