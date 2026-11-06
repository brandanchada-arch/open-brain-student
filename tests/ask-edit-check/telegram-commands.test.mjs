// Telegram /recent and /ask: the real telegram-bot/index.ts and the real _shared/ask.ts, with a
// fake Deno and fake fetch. Nothing real is called. Whether real Telegram behaves the same still
// needs one try on a phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDeno, installFakeFetch, FAKE_URL } from './helpers.mjs';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOT_FILE = new URL('../../supabase/functions/telegram-bot/index.ts', import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), 'tg-cmd-'));
mkdirSync(join(TMP, 'telegram-bot'));
symlinkSync(fileURLToPath(new URL('../../supabase/functions/_shared', import.meta.url)), join(TMP, '_shared'), 'junction');
let copies = 0;

const OWNER_TG = '111222333';
const OWNER = '00000000-0000-0000-0000-000000000001';
const SECRET = 'made-up-webhook-secret';

async function loadBot() {
  const served = installFakeDeno({
    TELEGRAM_BOT_TOKEN: 'fake-token', OWNER_USER_ID: OWNER, SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key',
    TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: OWNER_TG,
  });
  const copy = join(TMP, 'telegram-bot', `bot-${++copies}.ts`);
  copyFileSync(BOT_FILE, copy);
  await import(pathToFileURL(copy).href);
  return served.handler;
}

const send = (handler, text, from = OWNER_TG) => handler(new Request(`${FAKE_URL}/functions/v1/telegram-bot`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
  body: JSON.stringify({ message: { from: { id: Number(from) }, chat: { id: Number(from) }, text } }),
}));
const tgRoute = [(u) => u.includes('api.telegram.org'), () => ({ json: { ok: true } })];
const replies = (calls) => calls.filter((c) => c.url.includes('sendMessage')).map((c) => c.body.text);

test('/recent: lists the owner\'s newest non-archived notes', async () => {
  const calls = installFakeFetch([
    [(u) => u.includes('/rest/v1/thoughts'), () => ({ json: [{ content: 'Newest made-up note' }, { content: 'Older made-up note' }] })],
    tgRoute,
  ]);
  const res = await send(await loadBot(), '/recent');
  assert.equal(res.status, 200);
  const q = calls.find((c) => c.url.includes('/rest/v1/thoughts')).url;
  assert.match(q, new RegExp(`user_id=eq\\.${OWNER}`));
  assert.match(q, /archived_at=is\.null/);
  assert.match(q, /limit=5/);
  assert.equal(replies(calls).length, 1);
  assert.match(replies(calls)[0], /Your last 2 thought\(s\):\n\n1\. Newest made-up note\n\n2\. Older made-up note/);
});

test('/recent: no notes yet says so, and a stranger reads nothing', async () => {
  const calls = installFakeFetch([[(u) => u.includes('/rest/v1/thoughts'), () => ({ json: [] })], tgRoute]);
  const handler = await loadBot();
  await send(handler, '/recent');
  assert.match(replies(calls)[0], /don't have any thoughts/);
  const before = calls.length;
  await send(handler, '/recent', '999');
  assert.equal(calls.length, before, 'no database or Telegram call for a stranger');
});

test('/recent: a huge note still fits Telegram\'s limit', async () => {
  const calls = installFakeFetch([[(u) => u.includes('/rest/v1/thoughts'), () => ({ json: [{ content: 'long words '.repeat(20000) }] })], tgRoute]);
  await send(await loadBot(), '/recent');
  for (const t of replies(calls)) assert.ok(t.length <= 4096, `message of ${t.length} characters`);
  assert.ok(replies(calls).length >= 1);
});

function askWorld({ thoughts = [], library = [], flagged = [], llm = 'From your notes: the budget is fixed [T1].', flagFail = false } = {}) {
  const seen = { llm: [] };
  const calls = installFakeFetch([
    [(u) => u.includes('/functions/v1/generate-embedding'), () => ({ json: { embedding: [0.1, 0.2] } })],
    [(u) => u.includes('/rest/v1/rpc/search_thoughts'), () => ({ json: thoughts })],
    [(u) => u.includes('/rest/v1/rpc/search_library'), () => ({ json: library })],
    [(u) => u.includes('/rest/v1/thoughts'), () => ({ json: [] })],
    [(u) => u.includes('/rest/v1/library'), () => (flagFail ? { status: 500, json: {} } : { json: flagged.map((id) => ({ id, metadata: { door_check: { flagged: true } } })) })],
    [(u) => u.includes('/functions/v1/call-llm'), (_u, body) => { seen.llm.push(body); return { json: { text: llm } }; }],
    tgRoute,
  ]);
  return { calls, seen };
}
const T1 = { id: 'aaaaaaaa-0000-4000-8000-000000000001', content: 'Made-up note: the budget is fixed.', created_at: '2026-11-01T00:00:00Z', similarity: 0.9 };
const L1 = { id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Made-up article', doc_type: 'article', content: 'FLAGGED-LIBRARY-TEXT', created_at: '2026-11-01T00:00:00Z', similarity: 0.8 };

test('/ask: answers from the notes, lists the notes used, and searches as the owner', async () => {
  const { calls, seen } = askWorld({ thoughts: [T1] });
  const res = await send(await loadBot(), '/ask what did I decide about the budget?');
  assert.equal(res.status, 200);
  assert.equal(seen.llm.length, 1);
  assert.match(seen.llm[0].prompt, /the budget is fixed/);
  const search = calls.find((c) => c.url.includes('rpc/search_thoughts'));
  assert.equal(search.body.p_user_id, OWNER);
  const text = replies(calls).join('\n');
  assert.match(text, /the budget is fixed \[T1\]/);
  assert.match(text, /Notes used:\n\[T1\]/);
});

test('/ask: no matching notes means no AI call and no guess', async () => {
  const { calls, seen } = askWorld();
  await send(await loadBot(), '/ask something never written down');
  assert.equal(seen.llm.length, 0);
  assert.equal(replies(calls).length, 1);
});

test('/ask: flagged library text never reaches the AI, and a failed lookup leaves the library out', async () => {
  for (const world of [{ flagged: [L1.id] }, { flagFail: true }]) {
    const { seen } = askWorld({ thoughts: [T1], library: [L1], ...world });
    await send(await loadBot(), '/ask tell me about the budget');
    assert.equal(seen.llm.length, 1);
    assert.doesNotMatch(seen.llm[0].prompt, /FLAGGED-LIBRARY-TEXT/);
  }
});

test('/ask: empty question gets help, AI failure gets a plain sorry, a stranger gets nothing', async () => {
  const a = askWorld();
  await send(await loadBot(), '/ask');
  assert.match(replies(a.calls)[0], /Send \/ask followed by a question/);

  const b = installFakeFetch([
    [(u) => u.includes('/functions/v1/generate-embedding'), () => ({ json: { embedding: [0.1] } })],
    [(u) => u.includes('/rest/v1/rpc/'), (u) => ({ json: u.includes('search_thoughts') ? [T1] : [] })],
    [(u) => u.includes('/rest/v1/thoughts'), () => ({ json: [] })],
    [(u) => u.includes('/functions/v1/call-llm'), () => ({ status: 502, json: { error: 'down' } })],
    tgRoute,
  ]);
  const res = await send(await loadBot(), '/ask anything');
  assert.equal(res.status, 200);
  assert.equal(replies(b).length, 1);
  assert.doesNotMatch(replies(b)[0], /down|Error/);

  const c = askWorld({ thoughts: [T1] });
  await send(await loadBot(), '/ask anything', '999');
  assert.equal(c.calls.length, 0);
});
