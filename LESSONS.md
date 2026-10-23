# Lessons (this project)

- **Some edge functions exist only on Supabase, not in this repo** (daily-quiz, gap-questions, capture-voice, planner-bot, bc-*). Before changing a table, run `npx supabase functions list` and `npx supabase functions download <name> --workdir <scratch folder> --use-api` to find every reader. (2026-10-22)
- **The deployed copy can differ from the repo** (open-brain-mcp accepted `?key=` live but not in git). Diff the download against the repo before redeploying. (2026-10-22)
- **Querying `information_schema.triggers` prints the Database Webhook's service key** (it is written into the trigger). Don't select `action_statement` for webhook triggers. (2026-10-22)
- **A RESTRICTIVE RLS policy** (`as restrictive for select ... using (archived_at is null)`) hides rows from the live web app instantly, without redeploying it. The service role still sees everything. (2026-10-22)
- **Many files here have Windows (CRLF) line endings**, so string-matching edits with `\n` in a script fail silently and can wreck the file. Use the editor tool. (2026-10-22)
