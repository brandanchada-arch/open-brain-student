# Build notes: `npm run check` and the master guard (session 5)

Branch: `cloud/check-command` (made from `reference-library`). Nothing pushed to or merged into `master`.

## What this adds
| File | What it is |
|---|---|
| `package.json`, `package-lock.json` | Lets you run `npm run check`. Installs 3 test-only packages (nothing the app or the functions use): PGlite 0.5.12 + its pgvector plugin 0.0.13 (an in-memory Postgres) and jsonrepair 3.15.0 (the core-memory tests need it). The versions are pinned to the ones the other sessions tested with. |
| `scripts/check/` | The check itself (`run.mjs` starts it; one file per step) and `sql-stubs/` (stand-ins for Supabase, see below). |
| `.claude/settings.json` | Makes future Claude sessions in this repo stop and ask before a push to master, and refuse force pushes. |
| this file | Notes. |

No existing file was changed.

## How to use it (Windows or Linux)
From the `open-brain-student` folder:
```
npm install
npm run check
```
`npm install` is needed once (and again after `package.json` changes). It needs Node 22.18 or newer,
because the other sessions' tests load `.ts` files directly.

When all is well it prints about five lines and ends with `Check passed in Ns.`
When something is wrong it prints `FAIL` lines, then the problem in full, ends with
`Check FAILED (...)` and exits with code 1, so a hook can tell an agent "not done yet".
No keys needed and nothing real is contacted: no Supabase, no AI, no Telegram. Before tests run,
environment variables that look like keys (anything with SUPABASE, OPENAI, TOKEN, SECRET, API_KEY ...
in the name) are removed from what the tests can see.

Line meanings: `ok` passed · `skip` couldn't run on this computer (says why) · `part` partly
checked (says what wasn't) · `FAIL` a real problem. `skip` and `part` don't fail the check.

## What the check covers
1. **JS syntax.** Every `.js`/`.mjs`/`.cjs` file in the repo (not `node_modules`, not hidden folders),
   the `<script>` block written inside `index.html`, and the `.json` files (`manifest.json`,
   `package.json`, `.claude/settings.json`). This catches typos like a missing bracket. The browser
   files are checked exactly the way the browser reads them.
2. **Deno type-check of `supabase/functions`**, only if Deno is installed (`deno` on PATH,
   `%USERPROFILE%\.deno\bin\deno.exe`, or a path in the `DENO_BIN` variable). One check per function
   folder, from inside that folder so its own `deno.json` counts. The first run downloads the
   imports (e.g. `npm:@supabase/supabase-js`), later runs use Deno's cache. If a download fails
   (offline, blocked site) that folder is listed as **NOT type-checked**, never as passed.
   `npm run check -- --no-deno` skips this step.
3. **Tests.** Every test file in any folder named `tests` (`tests/core-memory/`,
   `tests/ask-edit-check/`, `pc-setup/tests/`, anything added later). Found by folder; a test file is
   one named `*.test.mjs` / `*.test.js` / `*.test.ts` (or `_test`, `-test`). Helper files like
   `fake-db.mjs` are not run on their own. Files that use `Deno.test` run with `deno test` (no
   network except this computer), the rest with Node's built-in test runner. No test files = pass.
4. **SQL smoke test in PGlite** (a real Postgres running inside Node, in memory). It loads, in order:
   `sql-stubs/00-supabase-platform.sql` (Supabase's roles, a fake `auth.uid()`, pgvector),
   `migration.sql`, `sql-stubs/10-earlier-levels.sql`, then every `supabase/sql/*.sql` by name (= date),
   then every `supabase/sql/*.sql` **a second time**, because the files promise "safe to run more than
   once". A file that fails is reported with the Postgres error and the line it points at.

**About the stubs (important).** The course Levels 2-6 built tables in the SQL Editor (`user_id`,
`embedding`, `metadata`, `thought_chunks`, `thought_links`, `brain_clusters` ...) and none of that is in
the repo. `10-earlier-levels.sql` is my best guess at it from CLAUDE.md and from what the SQL files use.
So "loads in PGlite" means "loads on top of my guess", not "will load on the live database".
pg_cron, pg_net, Vault and Storage are deliberately **not** stubbed: a SQL file that needs them fails
with a note saying PGlite can't do that, instead of a fake pass. (Today none do: the core-memory cron
block is commented out.)

## What it found
On this branch (`reference-library` + this work), with Deno 2.5.6:
- JS syntax: all 8 app files + the inline script parse. JSON files valid.
- SQL: `migration.sql` and `2026-10-22-reference-library.sql` load, and the reference-library file
  really is safe to run twice.
- Tests: none on this branch yet (expected).
- Deno: 11 of 16 function folders type-check with no errors. The other 5 (`capture-url`,
  `capture-youtube`, `open-brain-mcp`, `save-library`, `search-brain`) were **not** checked here because
  they import `https://esm.sh/@supabase/supabase-js@2` and this cloud computer can't reach esm.sh.
  On your PC they should be checked normally.

I also tried it on a scratch copy with the three other sessions' branches laid on top
(`cloud/core-memory`, `cloud/ask-edit-check`, `cloud/pc-setup`; files they both changed took the later
branch's version, so this is an approximation of the merge, not the real merge):
- **109 tests, 109 pass, 0 fail** in 14 files, in about 40 seconds for the whole check.
- All 4 SQL files load and re-run cleanly.
- 13 of 20 function folders type-check; the other 7 import from esm.sh (same reason as above).
- To prove it catches problems, I broke one thing of each kind on the scratch copy (a missing bracket
  in `gaps.js`, a bad line in the `index.html` script, a type error in `_shared/library.ts`, a failing
  Node test, a failing Deno test, a broken SQL file). Every one was reported with the file and line and
  the check exited 1.

Things I noticed but did **not** fix (the rules said report only):
1. **Merging the other branches:** `cloud/core-memory` and `cloud/ask-edit-check` both add lines at the
   same place near the end of `index.html`, so git will report a conflict there. Keep both sets of lines
   (`review.css`/`review.js` and `ask-edit-check.css`/`ask.js`/`edit-thought.js`/`door-flag.js`).
2. **A root `package.json` changes how Deno reads `npm:` imports.** When Deno sees a `package.json`, it
   looks for npm packages in `node_modules` instead of downloading them. My check avoids that with
   `--node-modules-dir=none`. I could not test whether `npx supabase functions deploy` is affected.
   The three functions with their own `deno.json` (`call-llm`, `enrich-thought`, `weekly-digest`)
   aren't affected. See go-live step 3: test one deploy before relying on it.
3. Functions import supabase-js two ways: `https://esm.sh/...@2` (5 functions) and
   `npm:@supabase/supabase-js@2` (8). Both work, but esm.sh is one more outside site that can be down,
   and offline checks can't cover it. Something to tidy up later.
4. Vercel will now see a `package.json`. With no `build` script it should still serve the site as
   plain files, but check the preview (go-live step 2). `package.json` will also be publicly readable
   on the site, like every repo file is; it holds no secrets.

## What it does NOT cover
- Whether the app works in a browser (no clicking through pages), or that the root files work
  together (e.g. two files declaring the same name).
- The live database: the real schema, real policies, real data. The SQL is tested against stand-ins.
- What the SQL *does* (beyond loading and re-running); the other sessions' SQL tests cover their parts.
- pg_cron jobs, pg_net calls, Vault, Storage, the database webhooks.
- Edge functions running for real (no Supabase, no OpenRouter, no Telegram). Deno only checks types.
- Edge functions whose imports can't be downloaded at that moment (listed as NOT type-checked).
- Deno tests when Deno isn't installed (listed as NOT run).
- YAML (`.github/workflows/keep-alive.yml`), CSS and HTML markup.
- Windows itself: written for Windows (no shell commands, paths built by Node) but only run on Linux
  here. If Deno is installed through npm (a `deno.cmd` file) the check may not find it; install Deno
  the normal way (`irm https://deno.land/install.ps1 | iex` in PowerShell) or set `DENO_BIN`.

## The master guard (`.claude/settings.json`)
- **Ask first** (`permissions.ask`) when a `git push` command mentions `master` anywhere: e.g.
  `git push origin master`, `git push origin HEAD:master`, `git push -u origin master`,
  `git -C somewhere push origin master`. Same rules for the Bash tool and the PowerShell tool.
- **Refuse** (`permissions.deny`) force pushes: `--force`, `--force-with-lease`, `-f`, and the
  `+branch` form, to any branch, in Bash and PowerShell.
- Pushes to other branches are not asked about, so unattended cloud sessions don't get stuck.
  (A branch that merely has "master" in its name, like `master-notes`, will also ask. That's on purpose.)

**These rules reduce the risk; they don't remove it.** They match the text of the command, and
unusual forms get past them, for example: plain `git push` while you're on master, a git alias,
`git push origin @:refs/heads/mas''ter`, a script that runs git, `-uf` written together, or a
push made through the GitHub website or API instead of git. A Claude session in "bypass permissions"
mode also skips `ask` rules. Real protection lives on GitHub: see go-live step 5.

## Go-live steps (on your PC, in order)
1. Merge this branch together with the other sessions' branches into a **non-master** branch
   (e.g. `reference-library`). Resolve the `index.html` conflict by keeping both sides (see above).
2. Push that branch (not master). Vercel builds a **preview** for every branch push; open the preview
   link from Vercel and check the app still loads and you can sign in. This is the test for item 4 above.
3. In PowerShell, from the `open-brain-student` folder:
   ```
   npm install
   npm run check
   ```
   It should end with `Check passed`. Optional but recommended: install Deno first so the edge functions
   get type-checked too. Then test that deploys still work with the new `package.json` by deploying
   one function you're about to deploy anyway (the go-live steps of the other sessions list several):
   `npx supabase functions deploy <name> --project-ref zqbjxbdborfahsomluye`. If it fails with
   "Could not find a matching package for 'npm:...' in the node_modules directory", tell Claude; the
   deploy failing means nothing changed on the live function.
4. Only after 1-3 pass, merge into `master` (that is the step that makes it live).
5. Real protection for master, on github.com → the repo → Settings → Branches (or Rules) →
   add a rule for `master`: require a pull request before merging, and block force pushes.
   This works no matter how a push is typed.
6. The "automatic hook" that runs `npm run check` when an agent finishes is a separate later step.
   It should run `npm run check` from this folder and treat exit code 1 as "not done".
