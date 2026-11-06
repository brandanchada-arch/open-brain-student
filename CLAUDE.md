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
| `open-brain-mcp` | MCP server for Claude Desktop (`get_core`, `add_session_log`, which can also save `about_me` notes, `recent_sessions`, `search_thoughts`, `list_recent`, `add_thought`, plus library tools `search_library`, `list_library`, `get_library_entry`, `library_quiz_material`, and `save_to_library`, which saves a page Claude has read into the library with the door check; `add_thought` is only for the owner's own thoughts). Auth: `MCP_ACCESS_KEY` in the `Authorization: Bearer` header |
| `search-brain` | The app's Search tab. Identifies the caller from their login token. `{library: true, course, doc_type, topic}` searches the library instead. `{ask: true}` = Ask mode (`_shared/ask.ts`) |
| `edit-thought` | Edit a thought / mark it outdated. User from the login token; old text goes to `thought_versions`; rebuilds embedding, links, chunks and tags via `_shared/enrich.ts` + `_shared/thought-edit.ts` |
| `review-proposal` | Brain → Review: approve / reject / undo brain page changes. User from the login token. Normal deploy (token check on) |
| `weekly-condenser` | Reads the week's notes and updates brain pages through `approve_brain_proposal`, so undo and history work. Since 2026-11-05 most changes apply automatically; big personal changes (`sensitive`), the first core page, and changes based only on library material wait in Review, and an unanswered one expires after 14 days. A waiting change doesn't stop a page updating: `review-proposal` merges it onto the current page on approval (`mergeLineChanges`). It and `weekly-digest` ask `call-llm` for `claude-sonnet-5-5` by name, because the default model did worse on real notes. **Never deploy with `--no-verify-jwt`, never add it to `config.toml` with `verify_jwt = false`** |
| `export-brain` | Read-only export for the PC backup, including `library_links`. Auth: `MCP_ACCESS_KEY`. Deploy with `--no-verify-jwt` |
| `capture-url`, `capture-youtube` | Save an article / YouTube transcript to the **library** (doc_type `article` / `transcript`), with embedding + chunks + door check |
| `save-library` | The app's PDF upload and pasted transcripts → library (embedding + chunks in the background, door check) |
| `telegram-bot` | Capture from Telegram, stamped with `OWNER_USER_ID`, plus `/ask`. Locked: needs Telegram's `TELEGRAM_WEBHOOK_SECRET` header and a sender matching `TELEGRAM_OWNER_ID`. Deploy with `--no-verify-jwt`. After changing the secret, POST `{"setup": true}` with that header to re-register the webhook |
| `weekly-digest` | Sunday summary via pg_cron of non-archived thoughts, saved to the **library** (doc_type `digest`). `config.toml` keeps `verify_jwt = false`, so it checks callers itself |
| `daily-quiz`, `gap-questions` | Study tab Quiz / Gaps. No pg_cron job or Brain Calendar code calls them (checked 2026-11-03); they still send to Telegram when called with the service role key. The owner turned quizzes off on 2026-11-05: the Quiz tab and "Quiz me" button are hidden in `index.html`, and the code stays. `gap-questions` asks deeper interview questions from a random sample of all notes, shown nearly whole so it reads where a thought ends up (`_shared/gap-prompt.ts`). Deploy with `--no-verify-jwt` |
| `backfill-embeddings`, `backfill-links`, `backfill-chunks` | One-time catch-up jobs, run in a PowerShell loop until `remaining` is 0. `backfill-chunks {"library": true}` repairs library embeddings/chunks |
| `_shared/chunking.ts`, `_shared/thought-chunks.ts` | Chunking logic copied from open-brain-express; `generateEmbedding` adapted to call our own `generate-embedding` |
| `_shared/library.ts` | Save a library entry, embed + chunk it, pick random quiz notes |
| `_shared/service-caller.ts` | `isServiceCaller` for scheduler-only paths: the exact `SUPABASE_SERVICE_ROLE_KEY`, or a token Supabase Auth accepts as admin. Never decode a token's role without checking it |
| `_shared/ask.ts`, `_shared/enrich.ts`, `_shared/thought-edit.ts` | Ask mode; enrichment shared by `enrich-thought` and edits; the rebuild after an edit |
| `_shared/door-check.ts` | Flags library text that tries to give an AI orders. Never blocks a save. Ask and the condenser leave flagged entries out |
| `_shared/core-memory.ts` | `get_core` and `add_session_log` logic |
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
- **Core memory** (2026-11-03, `supabase/sql/2026-11-03-core-memory.sql`): `brain_pages` (slugs `core`, `job-search`, `courses`, `mega`; `current_text`, `history_text`, which can only grow), `brain_page_versions` (undo), `brain_proposals`, `session_logs` (service role only). `approve_brain_proposal`, `reject_brain_proposal`, `undo_brain_page_change` are service role only. The browser can read pages, versions and proposals but not write them.
- **About me and core drop-offs** (2026-11-05, `supabase/sql/2026-11-05-about-me.sql`): `about_me_notes` (Claude's observations from sessions, saved without approval, owner can read and delete, kept out of `thoughts`) and `core_dropped_items` (each line that leaves the core page on approval, owner read only). Core "Current focus" lines carry `[last mentioned YYYY-MM-DD]`; the condenser proposes removing them after 21 days (`staleFocusLines`). Class work and MEGA stay off core.
- **Edits and outdated notes** (2026-11-03, `supabase/sql/2026-11-03-ask-edit-check.sql`): `thoughts.outdated_at`, `thoughts.replaced_by`, `thought_versions` (owner read only), `save_thought_edit(...)` (service role only). Outdated notes get half score in `search_thoughts` and are skipped by `find_links_for_thought`, quiz and gaps. Never hidden from search, never deleted.
- **Door check**: `library.metadata.door_check = {flagged, reasons, checked_at}`. `search_library` doesn't return `metadata`, so Ask looks the flag up separately and leaves the whole library out if that lookup fails.
- Schema changes: run with `npx supabase db query --linked --yes -f <file>.sql` from this folder (or the SQL Editor); `migration.sql` is only the original Level 1 table. Read-only queries: use `--read-only` instead of `--yes`.

## Checking before you ship
`npm install` once, then `npm run check`: JS syntax, Deno type-check of every function, all tests, SQL load test. Needs Node 22.18+. Nothing real is contacted. Deno isn't installed system-wide, so set `$env:DENO_BIN="$env:USERPROFILE\.open-brain\bin\deno.exe"` first or the type-check shows `skip`. 4 session-log tests skip on Windows (they need a shell script) and 3 browser tests skip without Playwright. They run in the cloud.

## Deploying
Always from this folder (running from `C:\Users\josep` fails with "Entrypoint path does not exist"):
```
npx supabase functions deploy <name> --project-ref zqbjxbdborfahsomluye --yes
```
`--yes` is required when Claude runs it (agent mode). `open-brain-mcp`, `telegram-bot`, `daily-quiz`, `gap-questions` and `export-brain` need `--no-verify-jwt`. Docker "not running" warnings are harmless.
The root `package.json` did not break `npm:` imports on deploy (tested with CLI 3.0.0, 2026-11-03).
Anything importing `_shared/` must be redeployed when the file it imports changes (`enrich-thought`, `edit-thought`, `search-brain`, `telegram-bot`, `backfill-chunks`,
`capture-url`, `capture-youtube`, `weekly-digest`, `weekly-condenser`, `save-library`, `daily-quiz`, `gap-questions`, `open-brain-mcp`).

## Running on a schedule and on the PC
- **Sunday condenser**: pg_cron job `weekly-brain-condenser`, `0 16 * * 0`, an hour after the digest. Uses Vault secret `service_role_key`, like the digest. Writes proposals only.
- **PC setup** (`pc-setup/README.md`; installed copies live in `%USERPROFILE%\.open-brain`, re-copy the scripts after changing them): skills in `%USERPROFILE%\.claude\skills`; settings and the MCP key in `.open-brain\.env`; backups in `%USERPROFILE%\open-brain-export`; Windows task `Open Brain weekly export`; SessionStart and SessionEnd hooks in `%USERPROFILE%\.claude\settings.json`; session logs in `%USERPROFILE%\claude-session-logs`, with `SESSION_LOG_UPLOAD=off`.
- **Master is protected on GitHub**: changes go through a pull request. `gh` isn't installed, so push a branch and merge it on github.com.

## Not checked yet
- **Telegram `/recent` and `/ask`**: the new `telegram-bot` is live and refuses strangers, but nobody tested these two commands after the deploy.
- **Sunday digest**: the fixed `weekly-digest` passed the token check on a real job run, but that run stopped at "fewer than 5 thoughts", so the first full digest on the new code is the Sunday after go-live.
- **Session log hook**: needs one real Claude Code session of 3+ messages ended with `/exit`, then exactly one new file in `claude-session-logs`.
- **`save_to_library` on a real page**: tested with fakes only. Needs Claude Desktop restarted or the connector reconnected to see it.
- **`voice` skill**: needs 3-5 writing samples in `%USERPROFILE%\.claude\skills\voice\samples.md`. Never in the repo copy.

## Gotchas learned the hard way
- **Reading a JWT's `role` proves nothing.** Functions with `verify_jwt = false` / `--no-verify-jwt` must check the token themselves (`_shared/service-caller.ts`).
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
