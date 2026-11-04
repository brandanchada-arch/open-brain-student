# Needs Brandan

Things that need you, or an action that was off limits overnight. Newest items go under their topic.

## Brain health check: going live

Nothing is live yet. Merge both `overnight/finish-brain` branches first, then do these in order from
`C:\Users\josep\open-brain-student`. The SQL goes first: until it runs, the new code stays quiet and the card stays hidden.

1. Add the table and function (safe to run again):
```bash
npx supabase db query --linked --yes -f supabase/sql/2026-11-04-brain-health.sql
```
2. Deploy the three functions that changed:
```bash
npx supabase functions deploy review-proposal --project-ref zqbjxbdborfahsomluye --yes
```
```bash
npx supabase functions deploy open-brain-mcp --no-verify-jwt --project-ref zqbjxbdborfahsomluye --yes
```
```bash
npx supabase functions deploy export-brain --no-verify-jwt --project-ref zqbjxbdborfahsomluye --yes
```
3. Then from `C:\Users\josep\brain-calendar` (this turns on the push):
```bash
npx supabase functions deploy bc-tick --no-verify-jwt --project-ref zqbjxbdborfahsomluye --yes
```

**What to expect.** The first push may be real: 2 notes from late October never got tags, because the tagging
step failed for them. They stop counting once they're 14 days old (the last one on Nov 7). Editing a note also retags it.
The PC backup check starts after the first backup that runs on the new `export-brain`.

**To switch off only the push:** set `enabled.watch_brain_health` to `false` in `bc_settings`. The card and the MCP tool keep working.

**Undo:**
- Functions: redeploy each one from `master`.
- SQL (nothing else depends on it once the functions are back on `master`):
```sql
drop function if exists public.brain_health(uuid, timestamptz);
drop table if exists public.health_heartbeats;
```

## Morning summary push

**What the records show (read-only, night of Nov 3):**
- All 13 summaries sent by push failed, from the first on Oct 22 through Nov 3. Sizes: 545 to 1,725 bytes.
- The largest push ever delivered was 269 bytes. Nothing between 269 and 545 bytes has been tried.
- The message is encrypted, so the push service sees only its size and headers. Those headers follow the same
  pattern as the pushes that work (same urgency, same time limit, same style of topic).
- So size is the leading suspect. **It isn't proven.** The push library's encryption shows nothing that changes
  at that size, and 545 bytes is far below the 4,096 the push standard promises.

**The check.** The 7:05 AM task reads this for you and writes `PUSH-LOG-RESULT.md`. To run it yourself, from
`C:\Users\josep\open-brain-student` (read-only, changes nothing), save this as `push-log.sql` in a temp folder:
```sql
select created_at, kind, push_host, status, left(error,300) as error, payload_bytes, body_chars, urgency, removed
  from bc_push_failures order by created_at desc limit 20;
```
```bash
npx supabase db query --linked --read-only -f push-log.sql
```

**What the answer means:**
| You see | It means | What happens next |
|---|---|---|
| 413 or `PayloadTooLarge` | Size really is the cause | Lower `MAX_PUSH_BYTES` in `push.ts`, or send a short push and leave the full text on Today |
| 400 with `BadWebPushTopic` or `BadPriority` | That header is being refused | Fix or drop that header |
| 403 with `BadJwtToken` or `ExpiredJwtToken` | The sign-in on the push | Check the VAPID keys, though other pushes would normally fail too |
| Status 0 with `TimeoutError` or a network error | The run or the network, not the message | Look at `bc-tick` logs around 14:00 UTC |
| No rows, and the summary row says `push` | It got through this time | Compare its size with the failures above |
| `kind = briefing` fails, `briefing_short` has no row | The short fallback worked | You should have had the short push at 7:00 |
