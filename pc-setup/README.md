# Open Brain — PC setup (draft)

Files for Brandan's Windows PC, drafted in a cloud session **without any live access**.
Nothing here has been installed or run on Windows yet. A later session on the PC reviews
and installs them, following the steps below in order.

Status: items 1–4 (skills, voice skill, export-brain function, weekly export) drafted. More items are added as they are finished.

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
Should print `OK thoughts`, `OK library`, `OK thought_links`, `Connection works`. Then the real run:
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
