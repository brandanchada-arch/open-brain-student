# Morning summary push: result of the 7:05 AM read

Read on 2026-11-04 at 14:05:45 UTC (7:05 AM local), read-only, from `bc_push_failures` and `bc_outbox`.

## What the rows show

**`bc_push_failures`: 1 row**

| When (UTC) | Kind | Push host | Status | Push service's reason | Payload bytes | Body chars | Urgency | Device removed |
|---|---|---|---|---|---|---|---|---|
| 14:00:10 | briefing | web.push.apple.com | 400 | `BadWebPushTopic` | 872 | 728 | high | no |

**`bc_outbox`, kinds `briefing` and `watch`, last 24 hours: 2 rows**

| When (UTC) | Kind | Sent via | Tries | Push error | Skipped | Text bytes |
|---|---|---|---|---|---|---|
| 14:00:08 | briefing | `push_short` | 1 | 400 `BadWebPushTopic` | none | 785 |
| 05:00:09 | watch | `push` | 0 | none | none | 68 |

## What it means

- **Using the guide in `NEEDS-BRANDAN.md`:** a 400 with `BadWebPushTopic` means the push's Topic header is
  being refused.
- **The full summary did not get through.** Apple's push service refused it with that reason.
- **The short version did get sent.** The summary row says `push_short`, and there is no failure row for
  `briefing_short`. The guide reads that as the short fallback working. The rows can't show whether the
  phone displayed it.
- **Size was not the reason given for this failure.** There is no 413 or `PayloadTooLarge`, and the refusal
  at 872 bytes names the Topic header.
- **The 68-byte watch push went through** with no error.

## A second read: outcomes by kind

Read straight after the first, read-only, as counts with no message text. "Topic length" is the kind's
length plus 9, because `outbox.ts` builds the Topic as `<kind>-<8 characters>`.

| Kind | Topic length | Sent via | Rows |
|---|---|---|---|
| briefing | 17 | skipped, "push failed" (Oct 22 to Nov 3) | 13 |
| briefing | 17 | `push_short` (today) | 1 |
| problem | 16 | `push` | 21 |
| event | 14 | `push` | 97 |
| email | 14 | `push` | 4 |
| watch | 14 | `push` | 1 |

- Rows before Oct 22 have no `sent_via`, so they aren't counted here.
- `proposal` and `reminder` also have 17-character Topics, but their rows show `summary`, not `push`. So no
  push with a 17-character Topic is on record as accepted.
- Today's short summary has a 23-character Topic and was sent.
- **One possible reading, not proven:** a text of 17 characters can't be valid base64, and Apple may check for
  that. Apple's reply names the Topic but doesn't say what is wrong with it.

## The fix

Pushes no longer send a Topic header. It's on `overnight/finish-brain` in brain-calendar, with a test that fails
without it. **Not deployed.**

## What these rows don't show

- This is one failure on one morning. The failures from before the log existed (since at least Oct 25) left
  no reason on record, so the rows can't say they had the same cause.
- They don't show whether a larger push would also pass once the Topic header is fixed.
