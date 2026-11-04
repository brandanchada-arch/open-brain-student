# Merge rehearsal report

Branches, merged in this order: `cloud/check-command`, `cloud/core-memory`, `cloud/ask-edit-check`, `cloud/pc-setup`.
Rehearsal branch: **`cloud/merge-rehearsal`**, made from `origin/master` (commit `cac7082`). Nothing was pushed to
master, the four source branches were not changed, nothing was deployed, and no live service was contacted.

## Verdict

**Yes, this is safe to take live, as long as the PC session follows the go-live list at the end in that order.**
The four branches merge with one small conflict (in `index.html`, resolved by keeping both sides). On the merged
code: all 109 tests pass, all 20 edge functions type-check, the new SQL files load together on one database in either
order and can be re-run, `search_thoughts` keeps exactly the same parameters with no second copy, and the merged app
loads in a browser with Review, Ask, Edit and the library warning all working and no errors. I fixed one safety
problem in the PC scripts (P1). The biggest open risk is **P2**: on a plain Deno setup, the new `package.json` stops
four functions from building. I proved that here, but I couldn't try the real Supabase deploy command. The go-live
list deploys a brand-new function first as a test and has a one-line workaround if it fails. P3 is an older problem
already on master (not caused by these branches). It doesn't block go-live, but it's worth fixing soon.

---

## Problems found, most serious first

| # | Severity | Where | Status |
|---|---|---|---|
| P1 | Medium | `cloud/pc-setup` session-log worker could fall back to an unrestricted `claude -p` | **Fixed here** (commit `73d0e4a`) |
| P2 | Medium | `cloud/check-command` root `package.json` breaks `npm:` imports in plain Deno | **Open**, workaround in go-live step 4 |
| P3 | Medium | `master` (not these branches): `weekly-digest` lets in a fake service-role token | **Fixed on `cloud/go-live-fixes`** (fix 1 in `FIXES-REPORT.md`; also `daily-quiz`, `gap-questions`, `weekly-condenser`) |
| P4 | Low | `cloud/check-command`: Vercel will see `package.json` | Open, checked by the preview in go-live step 1 |
| P5 | Low | personal details (no keys or real user ids found) | Open, optional tidy-up |
| P6 | Low | `cloud/ask-edit-check`: Ask also sends library entries the door check flagged | Open |
| P7 | Low | `cloud/pc-setup`: PC backup leaves out `library_links` | Open |
| P8 | Low | `cloud/ask-edit-check`: `save_thought_edit` relies on Supabase's default grant for the service role | Open, checked in go-live step 2 |
| P9 | Info | `master`: `enrich-thought` trusts whatever is POSTed to it | Open, outside scope |

**P1. (Medium, fixed here) Session-log summarizer could run an unrestricted Claude.**
`pc-setup/scripts/session-log-worker.js`, `summarize()` (was lines 139-146). The first try runs `claude -p` with
`--tools "" --strict-mcp-config --no-session-persistence` (no tools, no MCP servers). If that failed for *any* reason
(a timeout or a network blip, not only an unknown flag), it tried again with plain `claude -p`. That second run has
all your normal tools and MCP servers, including Open Brain's `add_thought`, under whatever your
`%USERPROFILE%\.claude\settings.json` allows. Meanwhile it reads your session transcript, which can contain outside
text (web pages, pasted documents). A page that says "call add_thought with …" could then be acted on. I found it by
reading the code (the retry arguments were literally `["-p"]`), and the branch's own test confirmed the retry happened.
**Fix:** the retry is gone. If the locked-down run fails, nothing is written and the error goes to
`.worker-errors.log`. The test now checks that there is no second call and no summary. `NOTES.md` was updated to match.
What this costs you: on an older Claude Code that doesn't know `--tools`, session logs simply don't get written.
Update Claude Code if that happens.

**P2. (Medium, open) A root `package.json` makes plain Deno refuse `npm:` imports.**
I installed Deno 2.5.6 here and ran `deno check` on copies of the functions, once with `package.json` at the top and
once without it:

| Function | Without `package.json` | With `package.json` |
|---|---|---|
| `weekly-condenser` | passes | fails |
| `review-proposal` | passes | fails: "Could not find a matching package for 'npm:@supabase/supabase-js@2' in the node_modules directory" |
| `daily-quiz` | passes | fails: same message |

Affected: every function that imports with `npm:` and has no `deno.json` of its own. In this go-live those are
`review-proposal`, `weekly-condenser`, `daily-quiz` and `gap-questions` (also the three `backfill-*` jobs).
Not affected: `call-llm`, `enrich-thought` and `weekly-digest` (they have their own `deno.json`; `enrich-thought`
passed with `package.json` present), and the functions that import from `esm.sh` or import nothing (`capture-url`,
`capture-youtube`, `save-library`, `search-brain`, `edit-thought`, `open-brain-mcp`, `export-brain`, `telegram-bot`,
`generate-embedding`). `npm run check` itself avoids the problem with `--node-modules-dir=none`.
What I **can't** prove: whether `npx supabase functions deploy` builds the same way plain Deno does. If the deploy
fails, it fails before anything changes on the live function, so trying is safe. Go-live step 4 deploys the new
`review-proposal` first as the test. If it fails, rename `package.json` while deploying and put it back afterwards.

**P3. (Medium, open, on `master`, outside the four branches) `weekly-digest` accepts a made-up service-role token.**
`supabase/config.toml` line 26 has `verify_jwt = false` for `weekly-digest`, so Supabase doesn't check tokens for it.
Its `isServiceCaller` (`supabase/functions/weekly-digest/index.ts`, around line 89) only *reads* the token's `role`.
It never checks the signature, and its comment assumes Supabase already did. So anyone can send a made-up token that
says `"role":"service_role"` and set off a digest (AI cost, plus a digest entry in your library). I found this by
reading the code; I didn't try it on the live site.
`weekly-condenser` copies the same check, so it is safe **only** with Supabase's token check on: deploy it with no
`--no-verify-jwt`, and never add it to `config.toml` with `verify_jwt = false`. As written, that's the case.
Go-live step 4b tests it with a made-up token. Fixing `weekly-digest` is outside this rehearsal. Two ways to fix it:
accept only the exact service role key, or turn the token check on for it.

**P4. (Low, open) Vercel and `package.json`.** There's no `build` script and no framework, so Vercel should keep
serving the folder as plain files. Two things will change: every deploy runs `npm install` (PGlite downloads, a few
MB, which only slows the deploy), and Vercel picks its Node version from `"engines": {"node": ">=22.18"}` (it may
print a warning; that doesn't matter for a static site). I can't run Vercel from here. Go-live step 1 checks a
**preview** deploy before anything reaches master.

**P5. (Low) Personal details.** I searched every added line in the four branches and in their git history since master.
I found no keys, tokens, passwords, phone numbers or real user ids. All test ids are obvious fakes, and so is the test
Telegram id. Locations only, values not repeated:
- `cloud/core-memory`, `BUILD-NOTES-core-memory.md` line 26: a Windows folder path that includes your PC user name.
  The same name is already public in `CLAUDE.md` on master, so nothing new is exposed.
- `cloud/core-memory`, commit `4aab4ff`: the author email is your address. It's already on many master commits.
- `cloud/pc-setup`, `pc-setup/README.md` line 63 and `pc-setup/skills/exam-prep/SKILL.md` line 35: one real course
  code used as an example.
- `pc-setup/skills/voice/samples.md` is a placeholder. Never paste real writing samples into the repo copy.

**P6. (Low, open) Ask sends door-flagged library entries to the AI** (`supabase/functions/_shared/ask.ts`,
`buildContext`). The core-memory condenser skips these entries. The Ask prompt says notes are data, the AI has no
tools, and the answer only goes to your screen, so the worst case is a misleading answer.

**P7. (Low, open) The weekly PC backup (`export-brain`) leaves out `library_links`** (takeaway → source links).
Unlike chunks and embeddings, a backfill can't rebuild them. The author noted this too.

**P8. (Low, open; can't check here) `save_thought_edit` relies on Supabase giving the service role access by default.**
`supabase/sql/2026-11-03-ask-edit-check.sql` removes EXECUTE from `public, anon, authenticated` but never grants it to
`service_role`. The core-memory file does grant it for its three functions. Supabase normally grants new functions to
`service_role` automatically, so this should work. If it doesn't, the Edit button fails with "permission denied".
Go-live step 2 checks it and gives the one-line fix.

**P9. (Info, open, on `master`, outside scope) `enrich-thought` has no caller check** (`verify_jwt = false`,
`config.toml` line 15). Anyone who knows a thought's id could make it re-embed or re-tag that thought with their own
text. Ids are random, so this is hard to exploit. `cloud/ask-edit-check` moved code out of this function without
changing what it does (I compared the removed and added code line by line).

### Security checklist
| Check | Result |
|---|---|
| User taken from the login token, never the body | OK. `review-proposal`, `edit-thought` and `search-brain` (Ask) use `auth.getUser()` with the anon client, and ignore a body `user_id` (tested, and checked again in the browser). Telegram `/ask`, the MCP tools, `weekly-condenser` and `export-brain` use `OWNER_USER_ID`. |
| Service-role code filters by user and `archived_at is null` | OK. Condenser (owner, `archived_at`, `outdated_at`), `save_thought_edit` (owner, not archived), rebuild (`.eq('user_id')`), Ask's outdated lookup, `export-brain` (owner; archived only on request, for the backup), `get_core`/`add_session_log` (owner). `search_thoughts`/`find_links_for_thought` keep `archived_at is null`. |
| New tables have RLS on | OK, tested on one database: `brain_pages`, `brain_page_versions`, `brain_proposals`, `thought_versions` (owner can read only), `session_logs` (no policies, so service role only). The browser can't write any of them. |
| EXECUTE revoked by name on security-definer functions | OK, tested: `anon` and `authenticated` can't run `approve_brain_proposal`, `reject_brain_proposal`, `undo_brain_page_change` or `save_thought_edit`. |
| `--no-verify-jwt` functions check their callers | `export-brain` checks `MCP_ACCESS_KEY` (refuses if the secret is missing). `telegram-bot`'s lock is unchanged. `daily-quiz`/`gap-questions` only gained one filter line. `weekly-condenser` must keep Supabase's token check on (P3). |
| Notes and outside content treated as data in AI prompts | OK. The condenser, Ask, door check, enrich and session-log prompts all say "data, not instructions" and fence the text off. The door check sends at most 3,000 characters to the AI. |
| No AI-written text going into `thoughts` | OK. The condenser writes only proposals (you approve them into `brain_pages`). Ask writes nothing. Session logs go to `session_logs`. An edit's rebuild writes AI tags/category/summary into `thoughts`, exactly as `enrich-thought` already does for every new thought. The one way around this was P1, now fixed. |

### Go-live steps in each branch's notes
All four are complete for their own part and in a safe order. What was missing: an order *across* the branches, and
one shared `sw.js` change (both core-memory and ask-edit-check asked for one; it's done once in this rehearsal).
ask-edit-check warned that "whichever SQL runs last wins for `search_thoughts`". That doesn't apply: only the
ask-edit-check file replaces it. None of the branches updates `CLAUDE.md` (see go-live step 9).

### Files that Vercel will serve publicly after the merge
Vercel serves every file in the repo. After the merge that includes the four notes files, this report,
`package.json`, `package-lock.json`, `scripts/check/`, `tests/`, `pc-setup/` (skills, PC scripts, `env.example`
with placeholders only) and probably `.claude/settings.json`. All of it is already public on GitHub, and none of it
holds a key or a real user id, so this exposes nothing new. `node_modules/` is in `.gitignore`.

---

## Conflicts and how they were resolved

| File | What clashed | Resolution |
|---|---|---|
| `index.html` (end of `<body>`) | core-memory added `<script src="review.js">`; ask-edit-check added `ask-edit-check.css`, `ask.js`, `edit-thought.js`, `door-flag.js` on the same line | Kept both: `review.js` first, then the four ask-edit-check lines. The files don't depend on each other's order. |
| `thoughts.outdated_at` / `replaced_by` | Both SQL files add them | No git conflict (different files). Both definitions are identical (`timestamptz`; `uuid references thoughts(id)`) and both use `add column if not exists`. Tested: after both files run twice there is exactly one `replaced_by` foreign key. |

Everything else merged automatically. `shell.js` (core-memory) and `enrich-thought` (ask-edit-check) were each
changed by only one branch.

**Other commits on this branch** (not merges):
- `507de05` `sw.js`: added `review.js`, `review.css`, `ask.js`, `edit-thought.js`, `door-flag.js`, `ask-edit-check.css`
  to `SHELL`, and bumped `VERSION` once, to `ob-2026-11-04-merge1`.
- `73d0e4a` the P1 fix (bug fix, separate commit).
- The report commits.

---

## Test results (all on the merged branch, Linux, Node 22.23)

| What | Result |
|---|---|
| `npm install` | OK (PGlite 0.5.12, pgvector plugin 0.0.13, jsonrepair 3.15.0) |
| `npm run check` without Deno | **Check passed**: JS syntax for 44 files plus the inline script; tests: 109 passed in 14 files; SQL: 4 of 4 files load, 3 re-run |
| `npm run check` with Deno 2.5.6 (installed from npm into a scratch folder) | **Check passed**: 13 of 20 function folders type-check. The other 7 import `esm.sh`, which this cloud computer can't reach. |
| Those 7 (`capture-url`, `capture-youtube`, `edit-thought`, `export-brain`, `open-brain-mcp`, `save-library`, `search-brain`) | Type-check with no errors when `esm.sh/@supabase/supabase-js@2` is pointed at the npm copy of the same library (scratch import map; the repo is unchanged). So **20 of 20** type-check, 7 of them against a stand-in. |
| `tests/core-memory/` | 36 pass, 0 fail |
| `tests/ask-edit-check/` (includes the headless-browser UI test, which ran and did not skip) | 53 pass, 0 fail |
| `pc-setup/tests/` (the README's command) | 20 pass, 0 fail (before and after the P1 fix) |
| **All new SQL on one database** (PGlite, see below) | 35 of 35 checks pass, in both orders |
| **Merged app in a browser** (see below) | 20 of 20 checks pass, no page errors |
| P2 experiment (plain Deno, with and without `package.json`) | Reproduced; see P2 |

**SQL together.** On one in-memory Postgres I loaded check-command's Supabase stand-ins, `migration.sql`, the
earlier-levels stand-in, the course's dedup trigger, `2026-10-22-reference-library.sql` (already live), then
`2026-11-03-core-memory.sql` and `2026-11-03-ask-edit-check.sql`, then both files again. I also tried the reverse
order. Both orders confirmed:
- both files load and re-run without errors;
- `search_thoughts(text, uuid, vector, double precision, integer, integer)` and `find_links_for_thought(...)` each have
  exactly one version, with the same parameters and result columns as before;
- one version each of `save_thought_edit` and the three brain-page functions;
- one `replaced_by` foreign key;
- RLS is on for all five new tables;
- anon and signed-in users can't run the four service-only functions;
- 4 pages seeded per user, with no duplicates after the re-run;
- marking a note outdated works, and it then ranks below its replacement in `search_thoughts`;
- `find_links_for_thought` never links to an outdated note or to another user's note;
- editing saves a version;
- approve, then undo, works on the core page;
- a signed-in user sees only their own pages and is refused when calling `approve_brain_proposal`;
- the browser can't write `thought_versions`.

**Browser.** I served the merged folder on 127.0.0.1 and opened it in headless Chromium at phone size, using the real
`index.html`, all the real scripts and the real supabase-js 2.45.4. The backend was a fake Supabase with made-up data
and a fake login; every other site was blocked. Checks that passed:
- the Brain chips are Map, Thoughts and Review;
- the Recent list shows an Edit button on every card and an Outdated badge;
- Ask sends `{ask: true}` and shows the answer as plain text, with sources;
- the editor opens and lists earlier versions, and Save sends `{id, content}` with no user id;
- Review lists the proposal, the sensitive warning and the 4 pages, and Approve (after "are you sure?") sends `{action, id}`;
- the Library shows the heads-up box for a flagged entry and none for a clean one;
- `<script>` and `<img onerror>` in made-up notes stayed text;
- the service worker installed as `ob-2026-11-04-merge1` and cached all 6 new files (so `SHELL` has no missing file, which would break the install).

The only console error was the Google Fonts request, which the test blocks on purpose.
The test scripts are not committed, to keep the site's public files unchanged.

## What couldn't be tested here
- **The live database.** The SQL ran on check-command's best-guess copy of the course schema, not the real one.
  Live columns, policies or grants may differ (see P8).
- **Real `supabase functions deploy`** (P2), Supabase's token check at its front door (P3), and real logins.
- **Vercel** (P4). No preview deploy can be made from here.
- **The 7 `esm.sh` functions against the real `esm.sh` build.** They were type-checked against the npm copy of the same library.
- **pg_cron, pg_net and Vault** (the commented-out Sunday schedule).
- **Telegram, OpenRouter and real AI answers.** Every AI reply in the tests is a fake.
- **Windows-only parts of `pc-setup`**: Task Scheduler, finding `claude.cmd`, OneDrive detection, hooks on Windows,
  and real `claude -p` flags. The session-log tests can only run on Linux or Mac.
- **The app on a real phone.**

---

## Combined go-live list for the PC session (exact order)

> **Updated by `cloud/go-live-fixes`** (see `FIXES-REPORT.md`). Take **`cloud/go-live-fixes`** live, not
> `cloud/merge-rehearsal`: it is the rehearsal plus four fixes. Changed or added steps are marked **(fixes)**.

Run everything from the `open-brain-student` folder in PowerShell. Never from `C:\Users\<you>`.
`<ref>` = `zqbjxbdborfahsomluye`. Do one step, check it, then go to the next.
**General undo for any function:** keep a master copy next to the repo
(`git worktree add ..\ob-master origin/master`, once, before step 4), then
`cd ..\ob-master; npx supabase functions deploy <name> --project-ref <ref> <same flags>`. A function that is new in
this merge has no master copy: undo it with `npx supabase functions delete <name> --project-ref <ref>`.

**0. Prepare (nothing live changes).**
`git fetch origin`, then `git switch cloud/go-live-fixes` **(fixes)**. Install Deno the normal way
(`irm https://deno.land/install.ps1 | iex`), then run `npm install` and `npm run check`. Expect `Check passed`, with
all 20 function folders type-checked (the PC can reach esm.sh).
Undo: nothing to undo.

**1. Vercel preview (nothing live changes).** The branch is already pushed, so Vercel should already have a
**preview** for `cloud/go-live-fixes` **(fixes)**. Open it from the Vercel dashboard and check two things:
- the build log shows no error;
- the site loads and you can sign in.

The preview uses the live database, so don't press the new buttons yet. Their functions aren't deployed.
If the preview fails to build or shows a blank page, stop: P4 is real. Note the error, then delete
`package.json`/`package-lock.json` on a copy of the branch and try again.
Undo: nothing (a preview is not the live site).

**2. SQL (adds things; old code keeps working).**
a. Save the current search functions first: in the SQL Editor run
   `select pg_get_functiondef('public.search_thoughts'::regproc) union all select pg_get_functiondef('public.find_links_for_thought'::regproc);`
   and keep the output in a file outside the repo.
b. `npx supabase db query --linked -f supabase/sql/2026-11-03-core-memory.sql`
c. `npx supabase db query --linked -f supabase/sql/2026-11-03-ask-edit-check.sql`
   (Both orders were tested. This one matches the go-live notes.)

Checks, in the SQL Editor:
- `select proname, count(*) from pg_proc where proname in ('search_thoughts','find_links_for_thought','save_thought_edit') group by 1;`
  should give 1 for each.
- `select slug from brain_pages;` should give 4 rows per signed-up user.
- `select has_function_privilege('service_role','public.save_thought_edit(uuid,uuid,text,boolean,uuid)','execute');`
  should be `true`. If it's `false` (P8), run:
  `grant execute on function public.save_thought_edit(uuid,uuid,text,boolean,uuid) to service_role;`
- Then, in the **live** app: Search for something you know is there. It should still find it.

Undo:
- To put the search functions back, re-run `supabase/sql/2026-10-22-reference-library.sql`. It's safe to re-run and
  restores the old `search_thoughts`/`find_links_for_thought`; the saved output from (a) is a second copy.
- The new tables and columns are unused by old code. Leave them; nothing deletes rows.

**3. Secrets.** Run `npx supabase secrets list --project-ref <ref>`. You should see `OWNER_USER_ID`, `MCP_ACCESS_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_OWNER_ID`. Nothing new is needed for the functions.
If either Telegram lock secret is missing, set it now and follow section 1 of `BUILD-NOTES-ask-edit-check.md` when
you deploy `telegram-bot` (step 4h).
Undo: `npx supabase secrets unset NAME --project-ref <ref>` for anything you added.
Also check `SUPABASE_ANON_KEY` is listed (Supabase normally adds it by itself). **(fixes)** The new service check
uses it to ask Supabase Auth about a token that isn't exactly your service key; without it, only the exact key works.

**3b. (fixes) See how the scheduled jobs call the functions (read-only, prints no keys).** In the SQL Editor:
`select jobname, schedule, command ~* 'authorization' as sends_token, command ~ 'vault\.decrypted_secrets' as token_from_vault, command ~* '(weekly-digest|daily-quiz|gap-questions|weekly-condenser)' as calls_changed_fn from cron.job;`
Don't select `command` itself: it may contain your key. Write down every job where `calls_changed_fn` is true; you
will test-run each one in step 4k. A job with `sends_token = false` is already refused today (old and new code both
refuse a missing token), so the fix doesn't change it; note it for later.
Undo: nothing (read-only).

**4. Deploy functions, in this order** (`npx supabase functions deploy <name> --project-ref <ref>` plus the flag shown).
**P2 test:** 4a is brand new, so it's the safe first try. If it fails with "Could not find a matching package for
'npm:…'", do every deploy below like this:
`Rename-Item package.json package.json.off` → deploy → `Rename-Item package.json.off package.json`.
Don't commit while it's renamed.

| | Function | Flags | Check after | Undo |
|---|---|---|---|---|
| a | `review-proposal` (new) | none (keep the token check) | POST without signing in → 401 | delete it |
| b | `weekly-condenser` (new) | none: **never `--no-verify-jwt`** (P3). Includes fix 1. | POST with header `Authorization: Bearer x.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x` (a made-up token) → must be **401**. Then run it once by hand with the service role key (core-memory notes step 4) → `{"ok": true, …}` | delete it; reject any proposals |
| c | `open-brain-mcp` | `--no-verify-jwt` | Claude Desktop lists `get_core`; calling it says "The core page is empty so far" (or shows your text); `search_thoughts` still works | redeploy from `..\ob-master` with `--no-verify-jwt` |
| d | `edit-thought` (new) | none | POST without signing in → 401 | delete it |
| e | `search-brain` | none (same as before) | live app's Search still works | redeploy from master copy |
| f | `capture-url`, `capture-youtube`, `save-library` | same as before (none) | capture one test web page from the live app. In the SQL Editor, `select metadata->'door_check' from library order by created_at desc limit 1;` → `{"flagged": false, …}` | redeploy from master copy |
| g | `daily-quiz`, `gap-questions` **(fixes: include fix 1)** | `--no-verify-jwt` (only after step 2!) | 1. Study → Quiz and Gaps load in the live app (your login stays in app mode). 2. POST each with the made-up token from 4b → **401** and **no** Telegram message. 3. POST `daily-quiz` once with `Authorization: Bearer <service role key>` → `{"ok":true,"sent":3,…}` (or `skipped`) and a quiz in Telegram. | `cd ..\ob-master; npx supabase functions deploy <name> --project-ref <ref> --no-verify-jwt` |
| h | `telegram-bot` | `--no-verify-jwt` | `/recent` still answers; `/ask what did I do last week?` → short answer + "Notes used" | redeploy from master copy with `--no-verify-jwt`, then POST `{"setup": true}` with the secret header |
| i | `enrich-thought` | none (`config.toml` keeps `verify_jwt = false`) | add a test thought in the app; within a minute it has tags | redeploy from master copy |
| j | `export-brain` (new) | `--no-verify-jwt` | POST with `Authorization: Bearer wrong` → 401 | delete it |
| k | **(fixes)** `weekly-digest` (fix 1) | none (`config.toml` keeps `verify_jwt = false` for it) | 1. POST with the made-up token from 4b → **401**. 2. **Go-live test run of the real Sunday job** (and of every job from step 3b): in the SQL Editor run `do $$ begin execute (select command from cron.job where jobname = '<job name from 3b>'); end $$;` then, after a minute, Edge Functions → `weekly-digest` → Logs must show `Saved digest …` or `No digest this week`, **not** 401. (Costs one AI call; same-week digest is updated, not duplicated.) For a `daily-quiz`/`gap-questions` job, success is a new message in Telegram. | If the job gets 401: `cd ..\ob-master; npx supabase functions deploy weekly-digest --project-ref <ref>` (for quiz/gaps add `--no-verify-jwt`), then note it in `FIXES-REPORT.md` |

`backfill-chunks`, `backfill-embeddings`, `backfill-links`, `call-llm` and `generate-embedding`
don't need a redeploy: no file they import changed. **(fixes)** `weekly-digest` now does (4k).

**5. Make the app live.** `sw.js` is already updated on this branch (6 new files; **(fixes)** `VERSION = 'ob-2026-11-04-fixes1'`).
Merge `cloud/go-live-fixes` **(fixes)** into `master`, preferably through a pull request on GitHub, and push. Vercel redeploys.
Checks on the phone (open the app, close it fully, open it again so the new service worker takes over):
- Brain shows Map / Thoughts / Review;
- Thoughts → type a question → **Ask** works;
- **Edit** a test thought, Save, then search for the new word;
- Review says "Nothing waiting" (or shows the proposal from 4b);
- Study → Library opens entries.
- **(fixes)** Today shows the morning summary under the notifications line (folded if already delivered), or
  nothing at all if `bc-calendar` doesn't answer `summary` yet. No error message either way.

Undo: `git revert -m 1 <merge commit>` and push. Vercel puts the old app back, and the new functions don't hurt the old app.

**6. Sunday schedule (optional, any time later).** Put the service role key in Vault. In
`2026-11-03-core-memory.sql` section 8, replace `<project-ref>` and `<VAULT_SECRET_NAME_PLACEHOLDER>`, then run only
that block in the SQL Editor. **Don't commit the filled-in file.**
Check: `select jobname, schedule from cron.job;` shows `weekly-brain-condenser` at `0 16 * * 0`, after the digest.
**(fixes)** Test run it once the same way as 4k: `do $$ begin execute (select command from cron.job where jobname = 'weekly-brain-condenser'); end $$;`
→ `weekly-condenser` Logs show `weekly-condenser: {"ok":true…` and not 401.
Undo: `select cron.unschedule('weekly-brain-condenser');`

**7. PC setup** (needs 4c and 4j live). Follow `pc-setup/README.md` items 1 → 2 → 3 (already deployed in 4j) →
"Before items 4–6" → 4 → 5 → 6. Each item there has its own check and undo. Always merge into
`%USERPROFILE%\.claude\settings.json`; never replace it.

**8. Protect master on GitHub:** Settings → Branches (or Rules) → add a rule for `master` that requires a pull request
and blocks force pushes (check-command step 5).
Undo: delete the rule.

**9. Paperwork.** Add the new functions, tables and `_shared` files to `CLAUDE.md`. The suggested lines are at the end
of `BUILD-NOTES-ask-edit-check.md`, plus `review-proposal`, `weekly-condenser`, `export-brain`, `brain_pages`,
`brain_proposals`, `session_logs` from core-memory and pc-setup. Note there that `weekly-condenser` must keep its
token check (P3), and add the P2 deploy workaround if step 4a needed it. **(fixes)** Also add the lines suggested
in `FIXES-REPORT.md` (`_shared/service-caller.ts`, and `weekly-digest` added to the "redeploy when `_shared/` changes" list).

---

Branch: **`cloud/merge-rehearsal`** (pushed; the environment accepted this name).
