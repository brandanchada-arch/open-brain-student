# Open Brain (student edition)

A personal knowledge base: thoughts saved to Supabase, auto-enriched by AI, searchable
by meaning and keyword from a web app, Telegram, and Claude Desktop (MCP).
The owner built it through the course in `curriculum/` and is new to coding —
explain changes in plain language.

## Where things run
- **Web app**: `index.html` + `shell.js`, `graph.js`, `gaps.js`, `library.js` (Study → Library tab) + `config.js` (Supabase URL + publishable key).
  Hosted on Vercel, which redeploys automatically on every push to `master`.
- **Brain Calendar pages** (code and docs live in `C:\Users\josep\brain-calendar`): `planner.js` is the
  Today tab; `brain-calendar.html` and `privacy.html` are public pages for Google's sign-in screen
  (https://open-brain-student-vert.vercel.app/brain-calendar.html and /privacy.html). Keep them reachable without login.
- **Database + functions**: Supabase project ref `zqbjxbdborfahsomluye`.
- **Keep-alive**: `.github/workflows/keep-alive.yml` pings the DB twice a week so the free project doesn't pause.

## Edge functions (`supabase/functions/`)
| Function | What it does |
|---|---|
| `enrich-thought` | DB webhook on insert: embedding → graph links → chunks (long thoughts) → tags/category/summary |
| `generate-embedding` | Text → 1536-number embedding via OpenRouter (`openai/text-embedding-3-small`). Returns `{embedding: null}` on failure, never throws |
| `call-llm` | LLM gateway; provider picked by `LLM_PROVIDER` secret. Nothing else talks to an AI company directly |
| `open-brain-mcp` | MCP server for Claude Desktop (`search_thoughts`, `list_recent`, `add_thought`, plus library tools `search_library`, `list_library`, `get_library_entry`, `library_quiz_material`, and `save_to_library`, which saves a page Claude has read into the library with the door check; `add_thought` is only for the owner's own thoughts). Auth: `MCP_ACCESS_KEY` in the `Authorization: Bearer` header |
| `search-brain` | The app's Search tab. Identifies the caller from their login token. `{library: true, course, doc_type, topic}` searches the library instead |
| `capture-url`, `capture-youtube` | Save an article / YouTube transcript to the **library** (doc_type `article` / `transcript`), with embedding + chunks |
| `save-library` | The app's PDF upload and pasted transcripts → library (embedding + chunks in the background) |
| `telegram-bot` | Capture from Telegram, stamped with `OWNER_USER_ID`. Locked: needs Telegram's `TELEGRAM_WEBHOOK_SECRET` header and a sender matching `TELEGRAM_OWNER_ID`. Deploy with `--no-verify-jwt`. After changing the secret, POST `{"setup": true}` with that header to re-register the webhook |
| `weekly-digest` | Sunday summary via pg_cron of non-archived thoughts, saved to the **library** (doc_type `digest`) |
| `daily-quiz`, `gap-questions` | Study tab Quiz / Gaps (also Telegram via the scheduler). `daily-quiz` takes `{course, topic}` for the Library tab's "Quiz me". Deploy with `--no-verify-jwt` |
| `backfill-embeddings`, `backfill-links`, `backfill-chunks` | One-time catch-up jobs, run in a PowerShell loop until `remaining` is 0. `backfill-chunks {"library": true}` repairs library embeddings/chunks |
| `_shared/chunking.ts`, `_shared/thought-chunks.ts` | Chunking logic copied from open-brain-express; `generateEmbedding` adapted to call our own `generate-embedding` |
| `_shared/library.ts` | Save a library entry, embed + chunk it, pick random quiz notes |
| `_shared/library-mcp.ts` | The MCP `save_to_library` tool: checks the input (max 400,000 chars), re-saving a URL updates that entry, door check + embedding + chunks |

## Database objects that matter
- `thoughts` (RLS on; `user_id`, `content`, `embedding`, `metadata`, `content_tsv`)
- `thought_links` (graph edges), `thought_chunks` (RLS on, **no policies on purpose** — service role only)
- `search_thoughts(query_text, p_user_id, query_embedding, match_threshold, match_count, max_per_document)` — hybrid RRF search
- `find_links_for_thought(...)`, `brain_graph()`, view `thoughts_needing_chunks`
- **Reference Library** (2026-10-22, `supabase/sql/2026-10-22-reference-library.sql`): class notes, transcripts,
  articles, PDFs and digests live in `library` (`title`, `content`, `doc_type` free text, `course`, `topic`, `tags`,
  `summary`, `source_url`, `metadata`, `embedding`, `brain_thought_id`, `moved_at`; RLS owner select/insert/update),
  `library_chunks` (service role only) and `library_links(thought_id, library_id, note)` (takeaway → its source entry).
  `search_library(query_text, p_user_id, query_embedding, match_threshold, match_count, p_course, p_doc_type, p_topic)`
  is hybrid RRF like `search_thoughts` (service role only); view `library_needing_chunks`.
- **Archived thoughts**: `thoughts.archived_at` + `thoughts.library_id`. 78 thoughts were moved on 2026-10-22 and archived,
  never deleted. A RESTRICTIVE policy hides them from signed-in users; every service-role query on `thoughts` must add
  `archived_at is null` itself (search_thoughts, find_links_for_thought, brain_graph, MCP, digest, quiz, gaps, backfills do).
- Schema changes: run with `npx supabase db query --linked -f <file>.sql` from this folder (or the SQL Editor); `migration.sql` is only the original Level 1 table.

## Deploying
Always from this folder (running from `C:\Users\josep` fails with "Entrypoint path does not exist"):
```
npx supabase functions deploy <name> --project-ref zqbjxbdborfahsomluye
```
`open-brain-mcp` needs `--no-verify-jwt`. Docker "not running" warnings are harmless.
Anything importing `_shared/` must be redeployed when `_shared/` changes (`enrich-thought`, `backfill-chunks`,
`capture-url`, `capture-youtube`, `weekly-digest`, `save-library`, `daily-quiz`, `open-brain-mcp`).

## Gotchas learned the hard way
- **Changing a SQL function's parameters**: drop every existing overload first, then `create`.
  `create or replace` with a new parameter list makes a second overload and every call fails
  with "function ... is not unique".
- **Service role bypasses RLS.** Any function using `SUPABASE_SERVICE_ROLE_KEY` must filter by
  user itself (`p_user_id` / `.eq("user_id", ...)`).
- **Never trust a user id from a request body** — get it from the caller's token (`auth.getUser()` with the anon client), as `capture-url` and `search-brain` do.
- **Some thoughts are huge** (100k+ chars YouTube transcripts). Never return full `content` in bulk; search results are capped at 3,000 chars.
- **Embedding calls can be rate-limited** during bulk jobs; chunks save with a null embedding and `backfill-chunks` with `{"fill_embeddings": true}` repairs them.
- Edge functions time out around 150s — keep backfill batches small for big documents.
- Secrets live in Supabase (Edge Functions → Secrets), never in this repo. `OWNER_USER_ID` and `BRAIN_OWNER_ID` hold the same UID.
