# Decisions

One line each: date, decision, why.

## Reference Library milestone (2026-10-22)

- 2026-10-22: Used the lead's `classification-2026-10-22.json` as-is (78 move, 6 links); no re-classification.
- 2026-10-22: Data move ran in 3 steps (copy → verify → archive); the archive step re-checks all 78 md5s and all 427 chunk md5s inside its own transaction and raises if anything differs. Why: never touch the brain before the copy is proven.
- 2026-10-22: Moved rows keep content, embedding, tags, summary, created_at; `metadata` keeps everything plus `brain_category`/`brain_enriched_at`. Title = `metadata.title`, else first line without markdown marks (max 200 chars).
- 2026-10-22: `library_chunks` copied from `thought_chunks` (same embeddings), so no new AI calls were needed for the 78.
- 2026-10-22: `thought_sources` (3 moved rows have one) left where it is, linked through `library.brain_thought_id`. Why: no column for it and it isn't needed for search (source chunks were copied).
- 2026-10-22: Foreign keys without ON DELETE CASCADE from `library_links`/`thoughts.library_id`. Why: nothing should ever delete silently; a later permanent delete must be deliberate.
- 2026-10-22: Archived thoughts hidden with a RESTRICTIVE select policy (live app on master hides them without a deploy) plus explicit `archived_at is null` in every service-role path: search_thoughts, find_links_for_thought, brain_graph, thoughts_needing_chunks, MCP list_recent + connections, weekly-digest, daily-quiz, gap-questions, backfill-embeddings, backfill-links.
- 2026-10-22: SQL functions changed with `create or replace` and identical parameter lists (no new overloads); `search_library` is new and dropped-then-created. EXECUTE on `search_library` revoked from anon/authenticated: only edge functions (service role) call it.
- 2026-10-22: New library rows get embeddings + chunks **inside the edge function that saves them** (`_shared/library.ts`), not through a DB webhook. Why: the existing enrich-thought webhook is a Supabase "Database Webhook" whose trigger has the service key written into it; copying that for `library` would mean handling a secret. The edge functions already have the key in their environment. `backfill-chunks {"library": true}` is the repair path.
- 2026-10-22: No AI tags/summary for new library rows (only embedding + chunks). Why: not in the requirements; keeps cost down.
- 2026-10-22: Library re-captures: same `source_url` (links, videos) or same title (weekly digest of the same week) updates the existing row instead of adding a copy, replacing the old dedup_key upsert.
- 2026-10-22: New `save-library` edge function for the app's PDF upload and pasted YouTube transcripts (the browser can't make embeddings). Long PDFs are indexed with `EdgeRuntime.waitUntil` after replying.
- 2026-10-22: Brought `daily-quiz` and `gap-questions` into the repo from the deployed source (they were only deployed, and newer than the copies in Documents\Open Brain Upgrades). Why: both read `thoughts` with the service role and needed the archived filter.
- 2026-10-22: Library "Quiz me" reuses `daily-quiz` with `{course, topic}` (random library notes, any date) and the existing Quiz card UI. The default daily quiz now also includes library notes with a course from the last 14 days, because the BUS-485 class notes moved out of the brain.
- 2026-10-22: Library tab lives under Study (chips: Gaps · Quiz · Library) in a new `library.js`, same look as the other cards. List/reader read `library` directly with the user's login (RLS); search goes through `search-brain` with `library: true`.
- 2026-10-22: Capture buttons for Link / YouTube / PDF now say "Save to Library". Typed/spoken thoughts still go to the brain.
- 2026-10-22: Deployed `open-brain-mcp` from the repo, which only accepts the key in the `Authorization` header. The previously deployed version also accepted `?key=` in the URL; the repo had already removed that (and Brandan's note says all clients send the header). Verified the connected client still works after deploy.
- 2026-10-22: Known edge case: re-saving text identical to an archived thought (same dedup_key) hits the archived row. From the web app the RLS check refuses it; via MCP/Telegram it silently updates the archived row. Left as is (rare); fix later if it ever matters.

## Telegram lock (2026-11-03)

- 2026-11-03: telegram-bot had no sender or webhook check, so anyone reaching it could read and add thoughts. It now requires TELEGRAM_WEBHOOK_SECRET and a sender matching TELEGRAM_OWNER_ID, and refuses everything if either is missing. Wrong secret gets 401 (Telegram retries, nothing lost); wrong sender gets a silent 200. TELEGRAM_OWNER_ID was copied from Brain Calendar's planner_chat_id.

## Go-live of the cloud builds (2026-11-03)

- 2026-11-03: Core memory: pages change only through proposals you approve (Brain → Review). The condenser writes proposals, never pages. Sensitive proposals need a second "are you sure?". Every approved change can be undone, and History can only grow (database trigger). Claude reads only "Current" through `get_core`.
- 2026-11-03: Ask answers only from your notes, cites [T1]/[L1], lists all sources if none are cited, and says it won't guess when notes don't cover it. No matches = no AI call.
- 2026-11-03: Edits clear the embedding, summary chunks and semantic links in the same transaction as the text change, so the backfills repair a failed rebuild. Exact duplicate text is refused and fully undone.
- 2026-11-03: Outdated means half score in search, never hidden or deleted. Marking outdated keeps old links but adds no new ones.
- 2026-11-03: Door check never blocks a save. If its AI double-check fails, it flags (a false warning costs nothing). Ask leaves flagged entries out, and leaves the whole library out if the flag lookup fails.
- 2026-11-03: Service caller check: exact service key, or a `service_role` token Supabase Auth accepts. Auth is asked because the Vault token's exact value can't be seen, and it fails closed. `weekly-digest` keeps `verify_jwt = false` so the Sunday job can't break at the gateway; the code check closes the hole. Tested on the real job: it got through.
- 2026-11-03: Session-log summarizer has no fallback to a plain `claude -p`: if the locked-down run fails, nothing is written. A plain run would have all tools and MCP servers while reading transcripts that can hold outside text.
- 2026-11-03: Took this live from separate git worktrees (`ob-golive`, `ob-master`), not by switching the main folder's branch, which held an uncommitted file. Before deploying, confirmed the 10 live functions being replaced matched master, so redeploying from master is a true undo.
- 2026-11-03: Merged straight to master with a merge commit rather than a pull request: `gh` isn't installed here and the branch had already been previewed. Brandan approved. Telegram `/recent` and `/ask` were left untested by his choice; the Sunday condenser schedule, PC setup and master protection were left for later (see `CLAUDE.md`).

### Left for later
- `open-brain-mcp` `list_recent` could show "(outdated)"; `search_library` could show the door-check flag.
- `weekly-digest` and `backfill-links` still include outdated notes. Add `.is("outdated_at", null)` if unwanted.
- `enrich-thought` has no caller check (`verify_jwt = false`). Anyone who knows a thought's random id could make it re-embed or re-tag that thought. Hard to exploit; worth locking one day.
- Functions import supabase-js two ways (`esm.sh` and `npm:`). Tidy up someday.
- Every repo file is served publicly by Vercel, including `tests/`, `pc-setup/` and `package.json`. None hold keys or real user ids.
- Re-running a digest on another day adds a new entry: the title holds the dates, so "same title updates" only applies to the same dates.

## Overnight build (2026-11-04)

- 2026-11-04: `weekly-digest` and `backfill-links` keep including outdated notes. Brandan's choice.
- 2026-11-04: `enrich-thought` uses the existing `isServiceCaller`. Yes/no queries showed the webhook sends a service-role JWT with no "Bearer", which that check already accepts. If the token ever stops matching the key and Auth can't be reached, the caller is refused and `backfill-embeddings` repairs what was missed.
- 2026-11-04: Friday suggestions save through a separate key-protected function, not an MCP tool, so no AI chat can send pushes.
- 2026-11-04: News lists and suggestions stay out of the condenser and quizzes: neither is a fact about the owner.

## After go-live (2026-11-03)

- 2026-11-03: `save_to_library` MCP tool added, because Claude reading a page is easier for Brandan than pasting links. Owner comes from `OWNER_USER_ID`, never the arguments; it never writes to `thoughts`; door check and indexing use the same path as the capture functions; re-saving a URL updates that entry.
- 2026-11-03: Sunday condenser reuses the existing Vault secret `service_role_key`, so nobody handled a key. Test run read 9 notes and wrote 3 first-draft proposals (core, job-search, mega) for Brandan to review.
- 2026-11-03: `MCP_ACCESS_KEY` printed into a Claude session's log during PC setup, because a masking filter only hid values of 16+ characters. Replacing it was offered and recommended (it's short, and it opens all notes over the internet). Brandan chose to keep it.
- 2026-11-03: Scheduled task and Claude settings hooks were installed by a script Brandan ran himself, because Claude Code's safety check blocked Claude from doing them.

## Merging the overnight work with automatic updates (2026-11-05)

- 2026-11-05: Where `overnight/finish-brain` and `master` disagreed, `master` won, with one exception Brandan chose: a topic page's first draft waits in Review if older notes were available to it, even if it doesn't cite them, because old notes can be out of date and the AI could use them without saying so. Weekly updates to a page with text stay automatic.
- 2026-11-05: Older notes back a topic page's first draft only once. A draft that was rejected, undone or left to expire isn't redrafted from them, though new notes can still fill the page. Core keeps `master`'s rule and tries again until it has text.
