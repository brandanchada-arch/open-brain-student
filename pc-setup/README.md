# Open Brain — PC setup (draft)

Files for Brandan's Windows PC, drafted in a cloud session **without any live access**.
Nothing here has been installed or run on Windows yet. A later session on the PC reviews
and installs them, following the steps below in order.

Status: items 1–2 (skills, voice skill) drafted. More items are added as they are finished.

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
