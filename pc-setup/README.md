# Open Brain — PC setup (draft)

Files for Brandan's Windows PC, drafted in a cloud session **without any live access**.
Nothing here has been installed or run on Windows yet. A later session on the PC reviews
and installs them, following the steps below in order.

Status: items 1–3 (skills, voice skill, export-brain function) drafted. More items are added as they are finished.

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
