# Needs Brandan

Things that need you, or an action that was off limits overnight. Newest items go under their topic.

## Push the overnight commits to GitHub (do this first)

The resume session's `git push` needed a person's approval, and nobody was there to give it. So its commits are
saved on this PC but aren't on GitHub yet. Nothing was forced or worked around. Run both:
```bash
git -C C:\Users\josep\open-brain-student push origin overnight/finish-brain
```
```bash
git -C C:\Users\josep\bc-overnight push origin overnight/finish-brain
```

## News filter: real YouTube feeds are unproven

One look-up at the public feeds returned 404 and 500 for all 5 channels tried, even though the channel pages gave ids.
A follow-up test was refused by the safety check because it tried several browser identities, so it never ran and
wasn't tried another way. (That first look-up also sent a browser-style identity, so it isn't a clean test either.)
**So nobody knows yet if these feeds work.** The test link is at the top of `C:\Users\josep\ai-notes\news-channels.sql`
(kept out of this public repo). Open it in your own browser; a page of XML means it's fine.

If it doesn't work, stop here: the list can't be made from feeds, and every Saturday you'd get a "couldn't read" push.

## News filter: going live

Do these after that feed check, from `C:\Users\josep\open-brain-student`, once the branch is merged.

1. **Check the channels.** Open `C:\Users\josep\ai-notes\news-channels.sql`. The fourth creator is a guess.
2. Add the tables, then the channels:
```bash
npx supabase db query --linked --yes -f supabase/sql/2026-11-04-news-filter.sql
```
```bash
npx supabase db query --linked --yes -f C:\Users\josep\ai-notes\news-channels.sql
```
3. Deploy the new function, plus the condenser so it skips news lists (normal deploys, token check on):
```bash
npx supabase functions deploy weekly-news-filter --project-ref zqbjxbdborfahsomluye --yes
```
```bash
npx supabase functions deploy weekly-condenser --project-ref zqbjxbdborfahsomluye --yes
```
4. Anything else importing `_shared/library.ts` should be redeployed too, so quizzes skip news lists: `daily-quiz`, `open-brain-mcp` (`--no-verify-jwt` on both).
5. Schedule it for Saturdays at 7:30 AM Arizona time (14:30 UTC). Run this in the SQL Editor. It uses the same Vault secret as the Sunday jobs:
```sql
select cron.schedule('weekly-news-filter', '30 14 * * 6', $cron$
  select net.http_post(
    url     := 'https://zqbjxbdborfahsomluye.supabase.co/functions/v1/weekly-news-filter',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000);
$cron$);
```

**Cost:** one AI call a week. Code stops AI calls at an estimated $1 a month, using deliberately high prices. Over the cap you still get the list, just without reasons.

**Decided for you:** Shorts are left out. The list is judged against your core page, which is empty until you approve a draft, and the list says so while it is.

**Undo:**
```sql
select cron.unschedule('weekly-news-filter');
drop table if exists public.news_listed;
drop table if exists public.news_runs;
drop table if exists public.news_channels;
```
Then redeploy `weekly-condenser` from `master`. Lists already saved stay in the Library.

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
