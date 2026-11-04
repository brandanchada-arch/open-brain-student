# Merge rehearsal report

Status: **Part 1 done (review). Part 2 (merge rehearsal) in progress.** This file is updated and pushed after each part.

Branches under review, in merge order: `cloud/check-command`, `cloud/core-memory`, `cloud/ask-edit-check`, `cloud/pc-setup`.
Rehearsal branch: `cloud/merge-rehearsal`, made from `origin/master` (commit `cac7082`).
All four branches were made from `reference-library`, which is already fully inside `master`, so each diff below is "branch vs master".

---

## Part 1: review of each branch (no code changed in this part)

How I reviewed: read each branch's notes, then every changed file in `git diff master...<branch>`, checked against
the gotchas in CLAUDE.md. I also scanned every added line in the git history since master (not just the final files)
for keys, tokens, user ids, emails, phone numbers and personal paths.

### Problems found, most serious first

**P1. (Medium, `cloud/pc-setup`) The session-log summarizer can fall back to an unrestricted `claude -p`.**
`pc-setup/scripts/session-log-worker.js`, lines 139-146 (`summarize`). The first attempt runs
`claude -p --tools "" --no-session-persistence --strict-mcp-config` (no tools, no MCP servers). If that attempt fails
for *any* reason (not only "unknown flag": also a timeout, a network blip, a non-zero exit), it retries with plain
`claude -p`. That second run has all the tools and MCP servers from your normal Claude Code settings (including the
Open Brain `add_thought` tool), under whatever permissions `%USERPROFILE%\.claude\settings.json` allows. The text it
is fed is your session transcript, which can contain outside text (web pages, pasted documents). So a page that says
"call add_thought with …" could get acted on, or AI text could end up in `thoughts`. The prompt asks it not to use
tools, but a prompt is not a lock. How I know: reading the code; the fallback args are literally `["-p"]`.
Safer fix: no fallback (if the locked-down run fails, write nothing and log the error). → **planned fix in Part 2.**

**P2. (Medium, `cloud/check-command`; can't prove from here) A root `package.json` may break `supabase functions deploy`.**
When Deno sees a `package.json` it can switch to "use the local `node_modules` folder" mode, and then `npm:` imports
that aren't in `node_modules` fail with "Could not find a matching package for 'npm:…'". Functions that use `npm:`
imports and have no `deno.json` of their own are the ones at risk: `review-proposal`, `weekly-condenser` (new), and
existing ones such as `daily-quiz`, `gap-questions`, `telegram-bot`-style helpers (see the check-command notes: 8
functions use `npm:@supabase/supabase-js@2`). Whether the Supabase CLI's bundler behaves like plain Deno here I can't
prove without the real CLI and network. The branch's own notes raise the same risk. Mitigation is in the go-live list
(test one deploy first; if it fails, temporarily rename `package.json` while deploying — that's a clean undo).

**P3. (Medium, *not in the four branches* — found on `master`) `weekly-digest` lets in anyone who sends a fake "service_role" token.**
`supabase/config.toml` line 26 sets `verify_jwt = false` for `weekly-digest`, so Supabase's front door does not check
tokens for it. Its `isServiceCaller` (`supabase/functions/weekly-digest/index.ts` ~line 89) only *decodes* the token
and reads `role`; it never checks the signature, and its comment assumes the front door already did. So a made-up
token with `"role":"service_role"` passes: anyone could trigger a digest (AI spend + a digest row in the library).
How I know: reading `config.toml` and the function; not tried against the live site (no live access).
Why it matters for this merge: `weekly-condenser` (`cloud/core-memory`) copies the same check. It is safe **only** if
it is deployed *with* JWT checking (no `--no-verify-jwt`, and no `verify_jwt = false` entry in `config.toml`).
The core-memory go-live steps do say "normal deploy", and `config.toml` has no entry for it, so as written it's fine.
The go-live list below adds a check for it. **Still open** for `weekly-digest` (outside this rehearsal's scope; a
fix would be to compare the token to the service role key only, or turn JWT checking on for it).

**P4. (Low, `cloud/check-command`; can't prove from here) Vercel will now see a `package.json`.**
With no `build` script and no framework, Vercel should still serve the folder as plain files. Two things change for
sure: every deploy will run `npm install` (downloads PGlite, a few MB, only slows the deploy) and Vercel will read
`"engines": {"node": ">=22.18"}` to pick its Node version (harmless for a static site; it may print a warning).
I can't run Vercel here. The go-live list checks a **preview** deploy before master.

**P5. (Low) Personal details.** No keys, tokens, passwords, phone numbers or real user ids were found in any of the
four branches or their history since master. Every uuid in tests is an obvious fake (`aaaaaaaa-…`, `11111111-…`,
`00000000-…`), and the Telegram id in tests is a made-up `111222333`. Things worth knowing (values not repeated here):
- `cloud/core-memory`, `BUILD-NOTES-core-memory.md` line 26: a Windows folder path that includes your PC user name.
  The same user name is already public in `CLAUDE.md` on master, so nothing new is exposed. Optional tidy-up.
- `cloud/core-memory`, commit `4aab4ff`: author email is your own address. It already appears on many master commits.
- `cloud/pc-setup`, `pc-setup/README.md` line 63 and `pc-setup/skills/exam-prep/SKILL.md` line 35: one real course
  code used as an example. Mild; it says which course you take.
- `pc-setup/skills/voice/samples.md` is a placeholder. Never paste real writing samples into the repo copy (the README says so too).

**P6. (Low, `cloud/ask-edit-check`) Ask sends library entries flagged by the door check to the AI.**
`supabase/functions/_shared/ask.ts` `buildContext`: flagged rows are not skipped (the core-memory condenser does skip
them). The Ask prompt says notes are data, the answer only goes to your screen or Telegram, and the AI has no tools,
so the harm is limited to a possibly wrong answer. Still open; noted for later.

**P7. (Low, `cloud/pc-setup`) The PC backup leaves out `library_links`** (takeaway → source links), which can't be
rebuilt by a backfill. The author noted this too. Still open (small follow-up).

**P8. (Info, *not in the four branches*, master) `enrich-thought` trusts whatever is POSTed to it.**
It is `verify_jwt = false` (`config.toml` line 15) and has no caller check, so anyone who knows a thought's id could
make it re-embed/re-tag that thought with their text. Ids are random uuids, so this is hard to exploit. `cloud/ask-edit-check`
moved its helper code into `_shared/enrich.ts` without changing behaviour (I compared the removed and added code).
Outside this rehearsal's scope; still open.

### Security checklist (what I checked and what I found)
| Check | Result |
|---|---|
| User from login token, never body | OK: `review-proposal`, `edit-thought`, `search-brain` Ask use `auth.getUser()` with the anon client. A `user_id` in the body is ignored (tested by both branches). Telegram `/ask`, MCP tools, `weekly-condenser`, `export-brain` use `OWNER_USER_ID`. |
| Service-role code filters by user + `archived_at is null` | OK: condenser (thoughts filtered by owner, `archived_at`, `outdated_at`), `save_thought_edit` (owner + not archived), `rebuildThought` updates `.eq('user_id')`, Ask's outdated lookup, `export-brain` (owner; archived only on request, for the backup), `get_core`/`add_session_log` (owner). `search_thoughts`/`find_links_for_thought` keep `archived_at is null`. |
| New tables have RLS on | OK: `brain_pages`, `brain_page_versions`, `brain_proposals` (owner select only), `session_logs` (no policies = service role only), `thought_versions` (owner select only). No insert/update policies, so the browser can't write them. |
| EXECUTE revoked by name on security-definer functions | OK: `approve_brain_proposal`, `reject_brain_proposal`, `undo_brain_page_change` (security definer) revoked from `public, anon, authenticated` by full signature. `save_thought_edit` (security invoker) also revoked. |
| `--no-verify-jwt` functions check callers | `export-brain`: checks `MCP_ACCESS_KEY` (constant-time) and refuses if the secret is missing. `telegram-bot`: lock unchanged (secret header + owner id). `daily-quiz`/`gap-questions`: one-line changes only. `weekly-condenser` must NOT be `--no-verify-jwt` (see P3). |
| Notes / outside content treated as data in AI prompts | OK: condenser, Ask, door check, enrich, session-log summarizer prompts all say "data, not instructions" and fence the text. Door check samples at most 3,000 chars. |
| No AI-written text into `thoughts` | OK with one caveat: condenser writes only `brain_proposals` (you approve into `brain_pages`); Ask writes nothing; session logs go to `session_logs`. Edit's rebuild writes AI tags/category/summary into `thoughts`' metadata columns, which is what `enrich-thought` already does for every new thought, not new content. Caveat: P1. |

### Go-live steps in each branch's notes
- **check-command**: complete. Its step 1 says "merge into a non-master branch, push, check the Vercel preview" — good order.
- **core-memory**: complete and in a safe order (SQL → Vault → deploy → try by hand → schedule → sw.js → master).
  Its `sw.js` step and ask-edit-check's `sw.js` step must be done **once together** (done in this rehearsal).
- **ask-edit-check**: complete. Its warning "whichever SQL file runs last wins for `search_thoughts`" doesn't bite:
  only the ask-edit-check file replaces `search_thoughts`/`find_links_for_thought`; core-memory only adds the same two
  columns with `if not exists`. `daily-quiz`/`gap-questions` must deploy after the SQL (they filter on `outdated_at`).
- **pc-setup**: complete for the PC side; its item 5/6 hooks need `get_core`/`add_session_log` live first
  (i.e. `open-brain-mcp` redeployed from the merged code). No web-app or SQL steps.
- Missing in all: nobody lists the order *across* branches, and CLAUDE.md isn't updated for any of them. The combined list at the end fixes the order.

### Files that become publicly served on Vercel after merging
Vercel serves every file in the repo. After the merge that adds: the four notes files, this report, `package.json`,
`package-lock.json`, `scripts/check/`, `tests/`, `pc-setup/` (skills, PC scripts, `env.example`, test fakes) and
probably `.claude/settings.json`. All of it is already public on GitHub (public repo) and none of it holds a key or a
real user id (see P5), so serving it adds no new exposure. `env.example` holds placeholders only. `node_modules/` is
in `.gitignore`, so it is never committed.
