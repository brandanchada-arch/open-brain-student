# Open Brain — PC setup (draft)

Files for Brandan's Windows PC, drafted in a cloud session **without any live access**.
Nothing here has been installed or run on Windows yet. A later session on the PC reviews
and installs them, following the steps below in order.

Status: all 7 items drafted. Tested on Linux against a local fake server only (see
"What could not be tested" at the end).

## Read this first (for the installing session)

- **Install in this order:** 1 → 2 → 3 → "Before items 4–6" → 4 → 5 → 6. Test each step before
  the next. Items 1–2 work on their own; 4 needs 3 deployed; 5 and 6 need `get_core` /
  `add_session_log` from branch `cloud/core-memory` deployed on `open-brain-mcp` (6 only needs it
  if you turn uploading on).
- **Nothing in here touches the web app or `master`.** Only `pc-setup/` and
  `supabase/functions/export-brain/` were added.
- **Keys** live only in `%USERPROFILE%\.open-brain\.env`. No script or settings file contains one.
- **`%USERPROFILE%\.claude\settings.json` is shared** with another plan (permissions, defaultMode,
  PreToolUse/Stop/Notification hooks). This plan adds **only** `SessionStart`, `SessionEnd` and
  `cleanupPeriodDays`. Always back it up, read the current file, and merge the snippet — never
  replace the file.
- Decisions made while drafting (and why) are in `NOTES.md`.

### Files

| Path | What it is |
|---|---|
| `skills/exam-prep`, `skills/job-application`, `skills/case-study` | Item 1 skills |
| `skills/voice/SKILL.md`, `skills/voice/samples.md` | Item 2 voice skill + empty samples file |
| `../supabase/functions/export-brain/` | Item 3 function (`handler.ts` = logic, `index.ts` = wiring) |
| `env.example` | Template for `%USERPROFILE%\.open-brain\.env` (placeholders only) |
| `scripts/lib/config.js` | Reads the `.env` settings |
| `scripts/lib/brain-api.js` | **The only file that calls Open Brain** (`get_core`, `add_session_log`, export-brain) |
| `scripts/weekly-export.js` | Item 4 export |
| `scripts/session-start-core.js` | Item 5 hook |
| `scripts/session-end-log.js`, `scripts/session-log-worker.js` | Item 6 hook + background worker |
| `settings-snippet.json` | The part to merge into `settings.json` (`<HOME>` is filled in during install) |
| `tests/` | Local tests with a fake server and fake `claude`; never touch the internet |

### Run all local tests

From the repo folder (Node 22+):
```
node --experimental-strip-types --test pc-setup/tests/export-brain.test.mjs pc-setup/tests/weekly-export.test.mjs pc-setup/tests/session-start.test.mjs pc-setup/tests/session-log.test.mjs
```
Expected: 20 tests, 0 failures. On Windows, leave out `session-log.test.mjs` (its fake `claude` only runs on Mac/Linux) → 13 tests.

## 1. Skills: exam-prep, job-application, case-study

**What:** instructions Claude Code loads when you ask for exam prep, a job application or a
case analysis. They use your Open Brain MCP tools (`search_library`, `list_library`,
`get_library_entry`, `library_quiz_material`, `search_thoughts`). They only read; they never
save to your brain unless you ask.

**Install** (PowerShell, from this repo folder):
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse -Force pc-setup\skills\exam-prep, pc-setup\skills\job-application, pc-setup\skills\case-study "$env:USERPROFILE\.claude\skills\"
```

**Test:** start a new Claude Code session, type `/exam-prep` (or say "help me study for my
BUS-485 exam"). It should ask which course/what the exam covers, then call `list_library`.

**Undo:** delete the folder(s) in `%USERPROFILE%\.claude\skills\`.

## 2. Voice skill

**What:** drafts text in your voice, learned only from samples **you** add. Without samples it
stops and asks.

**Install** (PowerShell, from this repo folder). The `if` line copies the sample file only if
you don't have one yet, so reinstalling never wipes your samples:
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\voice" | Out-Null
Copy-Item -Force pc-setup\skills\voice\SKILL.md "$env:USERPROFILE\.claude\skills\voice\"
if (-not (Test-Path "$env:USERPROFILE\.claude\skills\voice\samples.md")) { Copy-Item pc-setup\skills\voice\samples.md "$env:USERPROFILE\.claude\skills\voice\" }
code "$env:USERPROFILE\.claude\skills\voice\samples.md"
```
Paste 3–5 pieces of your own writing between the `SAMPLES START` and `SAMPLES END` lines and
save. **Never put samples in the repo copy** — the repo is public.

**Test:** before adding samples, ask "write a short thank-you email in my voice" — it should say
it has no samples. After adding them, ask again; it should draft and say what it matched.

**Undo:** delete `%USERPROFILE%\.claude\skills\voice` (copy your samples somewhere first if you want them).

See `NOTES.md` for the decisions made while drafting.

## 3. export-brain function (Supabase)

**What:** a read-only function the weekly export (item 4) calls, so your PC never needs the
all-powerful service role key. It accepts your existing `MCP_ACCESS_KEY`, only returns **your**
rows (`OWNER_USER_ID`), a small page at a time, and never returns embeddings.

**Install** (PowerShell, from this repo folder — deploying from your home folder fails):
```powershell
npx supabase functions deploy export-brain --no-verify-jwt --project-ref <your-project-ref>
```
No new secrets are needed: it uses `MCP_ACCESS_KEY` and `OWNER_USER_ID`, which already exist.

**Test:**
- Locally (any computer with Node): `node --experimental-strip-types --test pc-setup/tests/export-brain.test.mjs` → 6 passing.
- Live: the item 4 script with `--check` (see below) asks for one page and prints counts only.
- A wrong key must be refused: in PowerShell,
  `Invoke-RestMethod -Method Post -Uri https://<your-project-ref>.supabase.co/functions/v1/export-brain -Headers @{Authorization="Bearer wrong"} -Body '{"table":"thoughts"}' -ContentType application/json`
  should fail with **401**.

**Undo:** Supabase dashboard → Edge Functions → export-brain → Delete (or `npx supabase functions delete export-brain --project-ref <your-project-ref>`).
Nothing else depends on it except the weekly export.

## Before items 4–6: your settings file (once)

The PC scripts read `%USERPROFILE%\.open-brain\.env` — outside every repo, so the key is never committed.
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.open-brain" | Out-Null
if (-not (Test-Path "$env:USERPROFILE\.open-brain\.env")) { Copy-Item pc-setup\env.example "$env:USERPROFILE\.open-brain\.env" }
code "$env:USERPROFILE\.open-brain\.env"
```
Replace `<your-project-ref>` and `<paste-your-mcp-access-key-here>` with the real values (the same
`MCP_ACCESS_KEY` as in Supabase → Edge Functions → Secrets). Save.

Also copy the scripts to a fixed place so the hooks and scheduled task don't depend on where this
repo is:
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.open-brain\scripts" | Out-Null
Copy-Item -Recurse -Force pc-setup\scripts\* "$env:USERPROFILE\.open-brain\scripts\"
```
(Re-run that `Copy-Item` line after pulling script updates.)

**Undo:** delete `%USERPROFILE%\.open-brain` (this removes your key from the PC too).

## 4. Weekly export to your PC

**What:** once a week, saves your brain to `%USERPROFILE%\open-brain-export`:
- `thoughts\` and `library\`: one markdown file per non-archived thought and library entry, with
  front matter (tags, course, dates) that Obsidian understands. You can open the folder as an
  Obsidian vault.
- `backups\open-brain-backup-<date>.json`: everything needed to restore, including archived
  thoughts and graph links. Embeddings are left out (the backfill jobs rebuild them).
- `export-log.txt`: what each run did, including items that **no longer exist** in the brain.

It never deletes files. It refuses to run if the folder is inside OneDrive (or Dropbox/Google
Drive) or inside a git repo, because this is private text. **Treat the folder as a read-only
copy**: edits you make there are overwritten by next week's export.

Needs item 3 deployed first.

**Test, step by step:**
```powershell
node "$env:USERPROFILE\.open-brain\scripts\weekly-export.js" --check
```
Should print `OK thoughts`, `OK library`, `OK thought_links`, `OK library_links`, `Connection works`. Then the real run:
```powershell
node "$env:USERPROFILE\.open-brain\scripts\weekly-export.js"
```
Run it a second time: it should say this week's export already exists. Open the folder and check
a few files. Local tests (any computer):
`node --experimental-strip-types --test pc-setup/tests/weekly-export.test.mjs`

**Schedule it** (PowerShell; the task runs every 4 hours while you're logged in, and the script
exits straight away once this week is done, so a missed run — PC off, no internet — is retried
automatically. "Restart on failure" isn't used because it doesn't fire when a program just exits
with an error):
```powershell
$node = (Get-Command node).Source
$script = "$env:USERPROFILE\.open-brain\scripts\weekly-export.js"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(10) -RepetitionInterval (New-TimeSpan -Hours 4)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Open Brain weekly export" -Action $action -Trigger $trigger -Settings $settings -Description "Exports Open Brain to %USERPROFILE%\open-brain-export once a week"
```
Check it: `Start-ScheduledTask "Open Brain weekly export"`, then
`Get-ScheduledTaskInfo "Open Brain weekly export"` → `LastTaskResult` should be `0`.

A black window may flash for a moment every 4 hours. To hide it (Windows 11; untested here),
re-register with `-Execute "conhost.exe" -Argument "--headless `"$node`" `"$script`""` in the
action line. If the task then shows a non-zero `LastTaskResult`, go back to the plain version.

**Undo:** `Unregister-ScheduledTask "Open Brain weekly export" -Confirm:$false`. The export folder
stays; delete it by hand if you want.

## 5. Session-start hook: load your core page

**What:** each time a Claude Code session starts, it fetches your approved core page (`get_core`)
and hands it to Claude as background. If anything goes wrong (offline, server slow, no settings)
it says nothing and the session starts normally. Needs the settings file and scripts copied
(see "Before items 4–6") and `get_core` deployed on open-brain-mcp (branch `cloud/core-memory`).

**Install:** add the hook from `pc-setup/settings-snippet.json` to `%USERPROFILE%\.claude\settings.json`.
Another plan also edits that file (permissions, PreToolUse/Stop/Notification hooks), so **never
replace the file — merge into it**:
1. Back it up: `Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.backup.json"`
2. Print the snippet with your real home folder filled in:
   `(Get-Content pc-setup\settings-snippet.json -Raw).Replace('<HOME>', $env:USERPROFILE.Replace('\','/'))`
3. Open the current file (`code "$env:USERPROFILE\.claude\settings.json"`), read it, and add the
   `SessionStart` entry inside its existing `"hooks"` object (create `"hooks"` if it isn't there).
   Keep everything already in the file. If a `SessionStart` list already exists, add this entry to it.

**Test:** run the hook by hand — it should print a line of JSON containing your core page:
```powershell
'{}' | node "$env:USERPROFILE\.open-brain\scripts\session-start-core.js"
```
Then start `claude` and ask "what do you know about me from my core page?". Turn Wi-Fi off and
start a session again: it must start normally with no error.
Local tests: `node --experimental-strip-types --test pc-setup/tests/session-start.test.mjs`

**Undo:** remove the `SessionStart` entry from `settings.json`, or set `CORE_HOOK=off` in
`%USERPROFILE%\.open-brain\.env` to switch it off without editing settings.

## 6. Session log hook: short summaries of each session

**What:** when a Claude Code session ends, a background job asks `claude -p` for a short summary
(decisions, lessons, next steps) and saves it to `%USERPROFILE%\claude-session-logs`. Full
transcripts stay where Claude Code keeps them on your PC. Anything that looks like a key is
removed before summarizing and again after. Very short sessions are skipped. The hook returns
immediately, so closing Claude Code never waits for it. Summarizing uses your Claude plan, like
a short `claude -p` question.

**Uploading** summaries to Open Brain (`add_session_log`) is **off** until you turn it on. Read a
few logs first; if you're happy, set `SESSION_LOG_UPLOAD=on` in `%USERPROFILE%\.open-brain\.env`.
It never writes to your thoughts.

**Install:** same as item 5 — merge the `SessionEnd` entry and `"cleanupPeriodDays": 365` from
`pc-setup/settings-snippet.json` into your existing `%USERPROFILE%\.claude\settings.json`
(back it up first, read it, keep everything else). `cleanupPeriodDays` keeps Claude Code's local
transcripts for a year instead of deleting them sooner. If the file already has
`cleanupPeriodDays`, keep the larger number.

**Test:**
1. Start `claude`, have a short real conversation (at least 3 messages), then type `/exit`.
2. Within a minute or two a new `.md` file should appear in `%USERPROFILE%\claude-session-logs`.
   Open it and read it.
3. A session with just one message should **not** create a log.
4. Only one log per session: if you ever see several files for one session, set
   `SESSION_LOGS=off` straight away and report it (that would mean the loop guard failed).
5. If no log appears, look in `%USERPROFILE%\claude-session-logs\.worker-errors.log`.

Local tests (Mac/Linux only, because of the fake `claude`):
`node --experimental-strip-types --test pc-setup/tests/session-log.test.mjs`

**Undo:** set `SESSION_LOGS=off` in `.env` (instant), or remove the `SessionEnd` entry from
`settings.json`. Your saved logs stay until you delete them.

## What could not be tested (check these on the PC)

Everything above was tested on Linux with Node 22, against a fake server on `127.0.0.1` and a
fake `claude` command. Nothing was deployed or run against the real Supabase project.

| Item | Not tested yet | How to check |
|---|---|---|
| 1–2 Skills | Whether Claude Code picks them up and follows them well with your real library | Try each one once (item 1/2 "Test") |
| 3 export-brain | `index.ts` wiring (Deno wasn't available here; only `handler.ts` was tested), real column names, real speed with your 100k-character transcripts | Deploy, then `weekly-export.js --check`, then a full run |
| 4 Export | Windows paths, OneDrive detection with your real OneDrive folder, Task Scheduler commands, the `conhost --headless` option, Obsidian opening the folder | Try `--dir "$env:OneDrive\test"` → must refuse. Run the scheduled task once and check `LastTaskResult` is 0 |
| 5 Session-start hook | That Claude Code on Windows runs the `node "C:/Users/..."` command and shows the core page | Item 5 "Test" |
| 6 Session log hook | Windows only: finding `claude` (`claude.cmd` / `claude.exe`) through `cmd.exe`, the worker surviving after Claude Code closes, no console window popping up, the real `claude -p` flags (`--tools ""`), the real transcript format, `add_session_log` on the real server | Item 6 "Test"; watch for exactly one log per session |
| All | Real `get_core` / `add_session_log` replies (tested against the shape on branch `cloud/core-memory`) | Items 5–6 tests |
