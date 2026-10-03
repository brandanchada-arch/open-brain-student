# Open Brain (student edition)

A personal knowledge base: thoughts saved to Supabase, auto-enriched by AI, searchable
by meaning and keyword from a web app, Telegram, and Claude Desktop (MCP).
The owner built it through the course in `curriculum/` and is new to coding —
explain changes in plain language.

## Where things run
- **Web app**: `index.html` (the whole app, one file) + `config.js` (Supabase URL + publishable key).
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
| `open-brain-mcp` | MCP server for Claude Desktop (`search_thoughts`, `list_recent`, `add_thought`). Auth: `MCP_ACCESS_KEY` |
| `search-brain` | The app's Search tab. Identifies the caller from their login token |
| `capture-url`, `capture-youtube` | Save an article / YouTube transcript as a thought (URL/video id go in `metadata`) |
| `telegram-bot` | Capture from Telegram, stamped with `OWNER_USER_ID` |
| `weekly-digest` | Sunday summary via pg_cron, saved as a thought with category `digest` |
| `backfill-embeddings`, `backfill-links`, `backfill-chunks` | One-time catch-up jobs, run in a PowerShell loop until `remaining` is 0 |
| `_shared/chunking.ts`, `_shared/thought-chunks.ts` | Chunking logic copied from open-brain-express; `generateEmbedding` adapted to call our own `generate-embedding` |

## Database objects that matter
- `thoughts` (RLS on; `user_id`, `content`, `embedding`, `metadata`, `content_tsv`)
- `thought_links` (graph edges), `thought_chunks` (RLS on, **no policies on purpose** — service role only)
- `search_thoughts(query_text, p_user_id, query_embedding, match_threshold, match_count, max_per_document)` — hybrid RRF search
- `find_links_for_thought(...)`, view `thoughts_needing_chunks`
- Schema changes are run by hand in the Supabase SQL Editor; `migration.sql` is only the original Level 1 table.

## Deploying
Always from this folder (running from `C:\Users\josep` fails with "Entrypoint path does not exist"):
```
npx supabase functions deploy <name> --project-ref zqbjxbdborfahsomluye
```
`open-brain-mcp` needs `--no-verify-jwt`. Docker "not running" warnings are harmless.
Anything importing `_shared/` must be redeployed when `_shared/` changes (`enrich-thought`, `backfill-chunks`).

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
