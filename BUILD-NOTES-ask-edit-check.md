# Build notes: Ask, Edit, Door check (branch `cloud/ask-edit-check`)

Written for Brandan in plain language. Updated after every numbered item, because the
cloud session can stop at any time. Base branch: `reference-library`.

Nothing here has been deployed or run against the live database. Everything was
tested with fakes in this cloud computer.

## Status
| # | Item | Status |
|---|------|--------|
| 1 | Telegram lock | done (lock already existed, kept as is, tests added) |
| 2 | Ask mode | not started |
| 3 | Edit notes | not started |
| 4 | Door check | not started |

## 1. Telegram lock

**What I found.** The task said the bot accepted any sender. On the `reference-library`
branch that is no longer true: `telegram-bot/index.ts` already has the lock (see the
2026-11-03 line in DECISIONS.md). It:
- refuses everything (401) if `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_OWNER_ID` is missing,
- refuses (401) any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match,
- answers a silent 200 to any sender whose `message.from.id` isn't `TELEGRAM_OWNER_ID`,
- has a `{"setup": true}` request (needs the secret header) that re-registers the webhook with the secret.

**What I changed.** Nothing in the lock itself. The rules said "if a check already exists,
keep it and don't add a second one".

**One difference from the task wording, kept on purpose.** The task says "keep returning
200 to Telegram". The existing code returns 200 for everything that really comes from
Telegram (right secret), including strangers and errors. Only requests *without* the right
secret get a 401. That is the safer choice: during setup, if the secret isn't registered
yet, Telegram keeps the message and retries instead of the message being thrown away.
Someone who isn't Telegram learns nothing either way.

**Tests** (`tests/ask-edit-check/telegram-lock.test.mjs`, loads the real file with a fake
Deno and a fake `fetch`): missing secrets → 401 and no calls; wrong / missing header →
401; stranger with the right header → 200 and nothing read or saved; owner → thought saved.
Result: 4 of 4 pass.

**Go-live for the lock** (only needed if it isn't live yet; check with
`npx supabase secrets list --project-ref zqbjxbdborfahsomluye` — if both
`TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_OWNER_ID` are listed and the bot answers you, it's live):
1. Set both secrets first. The old code ignores them, so nothing changes yet.
2. Deploy `telegram-bot` with `--no-verify-jwt`. From now until step 3 your messages get a
   401 and Telegram *holds* them (nothing is lost).
3. Straight away, POST `{"setup": true}` to the function with the
   `X-Telegram-Bot-Api-Secret-Token: <your secret>` header. Expect `{"ok": true}`.
4. Send the bot `/recent`. If you get your thoughts back, it worked and the held
   messages arrive too. If you get nothing within a minute, open
   `https://api.telegram.org/bot<token>/getWebhookInfo` in a browser and read
   `last_error_message` — you'll *know* it's broken, rather than it failing silently.
