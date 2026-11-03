// Item 1: the Telegram lock. Loads the real telegram-bot/index.ts with a fake Deno + fake fetch.
// Run: node --test tests/ask-edit-check/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDeno, installFakeFetch, FAKE_URL } from './helpers.mjs';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOT_FILE = new URL('../../supabase/functions/telegram-bot/index.ts', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'tg-lock-'));
let copies = 0;

const OWNER_TG = '111222333';          // made-up Telegram id
const SECRET = 'made-up-webhook-secret';

async function loadBot(env) {
  const served = installFakeDeno({
    TELEGRAM_BOT_TOKEN: 'fake-token', OWNER_USER_ID: '00000000-0000-0000-0000-000000000001',
    SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', ...env,
  });
  // A fresh copy of the file each time, so the env above is read again (Node caches modules).
  const copy = join(TMP, `bot-${++copies}.ts`);
  copyFileSync(BOT_FILE, copy);
  await import(copy);
  return served.handler;
}

function tgRequest(update, secret) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return new Request(`${FAKE_URL}/functions/v1/telegram-bot`, { method: 'POST', headers, body: JSON.stringify(update) });
}

const msg = (fromId, text) => ({ message: { from: { id: Number(fromId) }, chat: { id: Number(fromId) }, text } });

test('refuses everything when the secrets are missing', async () => {
  const calls = installFakeFetch([[() => true, () => ({})]]);
  const handler = await loadBot({});
  const res = await handler(tgRequest(msg(OWNER_TG, '/recent'), ''));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, 'no database or Telegram calls');
});

test('refuses a request with the wrong or no webhook secret', async () => {
  const calls = installFakeFetch([[() => true, () => ({})]]);
  const handler = await loadBot({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: OWNER_TG });
  assert.equal((await handler(tgRequest(msg(OWNER_TG, 'hello'), 'wrong'))).status, 401);
  assert.equal((await handler(tgRequest(msg(OWNER_TG, 'hello')))).status, 401);
  assert.equal(calls.length, 0);
});

test('a stranger with the right secret gets a silent 200 and nothing is read or saved', async () => {
  const calls = installFakeFetch([[() => true, () => ({})]]);
  const handler = await loadBot({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: OWNER_TG });
  const res = await handler(tgRequest(msg('999', 'save this please'), SECRET));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('the owner with the right secret can save a thought', async () => {
  const calls = installFakeFetch([
    [(u) => u.includes('/rest/v1/thoughts'), () => ({ json: [{ id: 'x' }] })],
    [(u) => u.includes('api.telegram.org'), () => ({ json: { ok: true } })],
  ]);
  const handler = await loadBot({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: OWNER_TG });
  const res = await handler(tgRequest(msg(OWNER_TG, 'A made-up thought'), SECRET));
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.url.includes('/rest/v1/thoughts') && c.method === 'POST'));
});
