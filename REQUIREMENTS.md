# Milestone: Reference Library

Owner: Brandan. Branch: `reference-library` (do not touch `master`).
Why: the brain should hold Brandan's own thoughts and takeaways. Class material, video
transcripts and weekly digests crowd his own thoughts out of search.

## Already done (by the lead, 2026-10-22)
- Full backup: schema `backup` has `thoughts_20261022` (194 rows), `thought_links_20261022` (541),
  `thought_chunks_20261022` (453); checksum verified. Local copies in `C:\Users\josep\open-brain-backups\`.
- Classification: `C:\Users\josep\open-brain-backups\classification-2026-10-22.json`
  - `move[]`: 78 entries `{thought_id, doc_type, course, topic}` to move to the library.
  - `links[]`: 6 takeaways that stay in the brain `{thought_id, source_thought_id}`; link each to the
    library entry made from `source_thought_id`.
  - Everything not in `move[]` stays in the brain. This file has personal content: never commit it.

## Requirements
R1. **Library table** `public.library` in the same Supabase project: `id`, `user_id`, `title`, `content`,
    `doc_type` (free text, e.g. class-notes, transcript, digest, reference, sim-data, personal-doc, article;
    no CHECK so new kinds can be added later), `course` (e.g. BUS-485, FIN-451, ECN-460, null if none),
    `topic`, `tags text[]`, `summary`, `source_url`, `metadata jsonb`, `embedding vector(1536)`,
    `content_tsv` (same config as thoughts), `brain_thought_id` (original thought id), `created_at`
    (keep the original thought's date), `moved_at`. RLS on, owner-only select/insert/update policies.
    A `library_chunks` table mirroring `thought_chunks` (service role only) so long documents search well.
R2. **Link table** `public.library_links(thought_id, library_id, note)` for takeaways that came from a library entry.
R3. **Migration**: copy every `move[]` row into `library` (content, embedding, tags, summary, metadata,
    created_at; title from `metadata.title` or the first line), copy its `thought_chunks` into
    `library_chunks`, verify all 78 are there with identical content (md5) before touching the brain.
R4. **Archive, never delete**: add `archived_at timestamptz` and `library_id uuid` to `thoughts`; set both on
    the 78 moved rows. No `delete` on `thoughts`, `thought_links` or `thought_chunks`.
R5. **Hidden from normal brain use**: archived thoughts must not show in `search_thoughts`,
    `find_links_for_thought` (new links), `brain_graph`, MCP `list_recent`, `weekly-digest` input,
    or any web app list. Add a RESTRICTIVE select policy on `thoughts` for `authenticated`
    (`archived_at is null`) so the live web app on `master` hides them without a deploy, and add explicit
    `archived_at is null` filters in SQL functions and edge functions that use the service role.
    Follow the CLAUDE.md gotcha: keep the same parameter lists (no new overloads).
R6. **search_library**: SQL function `search_library(query_text, p_user_id, query_embedding, match_threshold,
    match_count, p_course, p_doc_type, p_topic)` (hybrid RRF like `search_thoughts`, using `library_chunks`),
    plus MCP tools in `open-brain-mcp`: `search_library` (query + optional course/doc_type/topic filters),
    `list_library` (what's there: counts by course/doc_type/topic, or entries for a course),
    `get_library_entry` (one entry by id, content in pages of ~6,000 chars), and
    `library_quiz_material` (random notes for a course/topic, sized for Claude to quiz Brandan).
    Normal `search_thoughts` must never return library rows. Results capped at 3,000 chars as today.
R7. **Takeaway links**: insert the 6 `links[]` into `library_links`; `search_thoughts` results via MCP show
    "From library: <title> (<id>)" for linked thoughts.
R8. **New captures go to the right place**: `capture-youtube` and `capture-url` save to `library`
    (doc_type transcript / article), `weekly-digest` saves its digest to `library` (doc_type digest) and only
    reads non-archived thoughts. New library rows get an embedding (+ chunks when long) via the existing
    `generate-embedding` / `_shared` chunking code. The web app's PDF upload (if any) also goes to the library.
R9. **Study in the web app**: a Library tab filterable by course, type and topic, with search, a reader,
    and a "Quiz me" button for the selected course/topic (use the existing `call-llm` gateway or the
    existing Gaps/Quiz code). Keep the current look.
R10. **Review list for Brandan**: write `C:\Users\josep\open-brain-backups\moved-list-2026-10-22.md` with counts by
    doc_type and course, every moved title, and a 10-row sample; mark that permanent deletion awaits his approval.
R11. Docs: update `CLAUDE.md` (new tables, functions, tools), add decisions to `DECISIONS.md`,
    lessons to `LESSONS.md`. Commit on `reference-library`. Deploy the changed edge functions.

## Done when
Backup verified; nothing lost (194 thoughts still exist, 78 archived + 116 active, 78 library rows with
matching md5); a normal brain search returns his own thoughts and no archived rows; `search_library` with
course BUS-485 returns his BUS-485 class notes.
