// Item 1: the Telegram lock. Loads the real telegram-bot/index.ts with a fake Deno + fake fetch.
// Run: node --test tests/ask-edit-check/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDeno, installFakeFetch, FAKE_URL } from './helpers.mjs';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOT_FILE = new URL('../../supabase/functions/telegram-bot/index.ts', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'tg-lock-'));
// The bot imports ../_shared/ask.ts, so mirror that folder layout next to the copies.
mkdirSync(join(TMP, 'telegram-bot'));
symlinkSync(fileURLToPath(new URL('../../supabase/functions/_shared', import.meta.url)), join(TMP, '_shared'), 'junction');
let copies = 0;

const OWNER_TG = '111222333';          // made-up Telegram id
const SECRET = 'made-up-webhook-secret';

async function loadBot(env) {
  const served = installFakeDeno({
    TELEGRAM_BOT_TOKEN: 'fake-token', OWNER_USER_ID: '00000000-0000-0000-0000-000000000001',
    SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', ...env,
  });
  // A fresh copy of the file each time, so the env above is read again (Node caches modules).
  const copy = join(TMP, 'telegram-bot', `bot-${++copies}.ts`);
  copyFileSync(BOT_FILE, copy);
  await import(pathToFileURL(copy).href);
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

test('/ask from the owner answers from the notes and lists them', async () => {
  const sent = [];
  const calls = installFakeFetch([
    [(u) => u.includes('/functions/v1/generate-embedding'), () => ({ json: { embedding: [0.1, 0.2] } })],
    [(u) => u.includes('/rpc/search_thoughts'), () => ({ json: [
      { id: 't-1', content: 'Made-up note: the study group meets on Tuesdays.', created_at: '2026-10-01T10:00:00Z' },
    ] })],
    [(u) => u.includes('/rpc/search_library'), () => ({ json: [] })],
    [(u) => u.includes('/rest/v1/thoughts?select=id'), () => ({ json: [] })],
    [(u) => u.includes('/functions/v1/call-llm'), () => ({ json: { text: 'It meets on Tuesdays [T1].' } })],
    [(u) => u.includes('api.telegram.org'), (_u, body) => { sent.push(body.text); return { json: { ok: true } }; }],
  ]);
  const handler = await loadBot({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: OWNER_TG });
  const res = await handler(tgRequest(msg(OWNER_TG, '/ask when does the study group meet?'), SECRET));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Tuesdays \[T1\]/);
  assert.match(sent[0], /Notes used:\n\[T1\]/);
  const rpc = calls.find((c) => c.url.includes('/rpc/search_thoughts'));
  assert.equal(rpc.body.p_user_id, '00000000-0000-0000-0000-000000000001', 'uses OWNER_USER_ID');
  // Nothing was saved as a thought.
  assert.ok(!calls.some((c) => c.url.includes('/rest/v1/thoughts?on_conflict')));
});

test('/ask from a stranger does nothing', async () => {
  const calls = installFakeFetch([[() => true, () => ({})]]);
  const handler = await loadBot({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: OWNER_TG });
  const res = await handler(tgRequest(msg('999', '/ask what are his secrets?'), SECRET));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});
