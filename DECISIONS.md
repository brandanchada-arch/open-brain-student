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
