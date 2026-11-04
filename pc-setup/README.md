# Open Brain — PC setup (draft)

Files for Brandan's Windows PC, drafted in a cloud session **without any live access**.
Nothing here has been installed or run on Windows yet. A later session on the PC reviews
and installs them, following the steps below in order.

Status: item 1 (skills) drafted. More items are added as they are finished.

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

See `NOTES.md` for the decisions made while drafting.
