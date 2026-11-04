// Fix 1: made-up ("forged") service-role tokens must get no service access.
// Loads the real weekly-digest, daily-quiz, gap-questions and weekly-condenser files in Node
// with a fake Deno, a fake supabase-js and a fake fetch. Nothing real is ever called.
// Run: node --test tests/go-live-fixes/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeDeno, installFakeFetch, FAKE_URL } from '../ask-edit-check/helpers.mjs';
import { OWNER, OWNER_LOGIN, OTHER_LOGIN } from './fake-supabase.mjs';

const FN = new URL('../../supabase/functions/', import.meta.url);
const FAKE_SB = new URL('./fake-supabase.mjs', import.meta.url).href;
const TMP = mkdtempSync(join(tmpdir(), 'svc-caller-'));
const REAL_KEY = 'made-up-real-service-role-key';
const ANON = 'made-up-anon-key';
let copies = 0;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload, secret = 'a-secret-nobody-real-uses') {
  const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}
// Made-up tokens an attacker could write: the one from the rehearsal report, and a "properly" signed
// one that uses the wrong secret. Plus a genuine-looking one our fake Auth will accept (like a Vault token).
const FORGED = ['x.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x', jwt({ role: 'service_role', iss: 'supabase' })];
const GENUINE_OTHER = jwt({ role: 'service_role', iss: 'supabase', note: 'vault copy' }, 'the-projects-real-secret');

// Copy a function's index.ts so the env is read again, pointing its imports at the fakes / real files.
async function load(name, env = {}) {
  const served = installFakeDeno({
    SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: REAL_KEY, SUPABASE_ANON_KEY: ANON,
    OWNER_USER_ID: OWNER, OWNER_TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'fake', ...env,
  });
  let src = readFileSync(new URL(`${name}/index.ts`, FN), 'utf8')
    .replaceAll('"npm:@supabase/supabase-js@2"', JSON.stringify(FAKE_SB))
    .replaceAll('"npm:jsonrepair@3"', JSON.stringify(FAKE_SB))
    .replaceAll('"../_shared/', `"${new URL('_shared/', FN).href}`)
    .replaceAll('"./handler.ts"', JSON.stringify(new URL(`${name}/handler.ts`, FN).href));
  const copy = join(TMP, `${name}-${++copies}.ts`);
  writeFileSync(copy, src);
  await import(copy);
  return served.handler;
}

// Fake Supabase Auth: only GENUINE_OTHER is a correctly signed service-role token.
function fakeNetwork({ authDown = false } = {}) {
  globalThis.__sb = { from: [], getUser: [] };
  return installFakeFetch([
    [(u) => u.includes('/auth/v1/admin/users'), (_u, _b, init) => {
      if (authDown) throw new Error('network down');
      return init.headers.Authorization === `Bearer ${GENUINE_OTHER}` ? { json: { users: [] } } : { status: 401, json: { msg: 'invalid JWT' } };
    }],
    [(u) => u.includes('api.telegram.org'), () => ({ json: { ok: true } })],
    [(u) => u.includes('/functions/v1/call-llm'), () => ({ json: { text: '{"questions":[]}' } })],
  ]);
}

const post = (token, body = {}) => new Request(`${FAKE_URL}/functions/v1/x`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const ALL = ['weekly-digest', 'daily-quiz', 'gap-questions', 'weekly-condenser'];

for (const name of ALL) {
  test(`${name}: made-up service tokens are refused and nothing is read or sent`, async () => {
    const handler = await load(name);
    for (const token of FORGED) {
      const calls = fakeNetwork();
      const res = await handler(post(token));
      assert.equal(res.status, 401, `forged token ${token.slice(0, 12)}…`);
      assert.deepEqual(globalThis.__sb.from, [], 'no table was read');
      assert.ok(!calls.some((c) => c.url.includes('telegram') || c.url.includes('call-llm')), 'no Telegram message, no AI call');
      assert.ok(calls.some((c) => c.url.includes('/auth/v1/admin/users')), 'Supabase Auth was asked to check the signature');
    }
  });

  test(`${name}: no token at all is refused without asking Auth`, async () => {
    const handler = await load(name);
    const calls = fakeNetwork();
    assert.equal((await handler(post(''))).status, 401);
    assert.equal(calls.length, 0);
  });

  test(`${name}: the real service role key still gets service access`, async () => {
    const handler = await load(name);
    const calls = fakeNetwork();
    const res = await handler(post(REAL_KEY));
    assert.notEqual(res.status, 401);
    assert.ok(globalThis.__sb.from.includes('thoughts'), 'it went on to read thoughts');
    assert.deepEqual(globalThis.__sb.getUser, [], 'treated as the scheduler, not as an app user');
    assert.ok(!calls.some((c) => c.url.includes('/auth/v1/')), 'exact key needs no Auth call');
  });

  test(`${name}: a genuine service token that differs from the key (e.g. from Vault) still works`, async () => {
    const handler = await load(name);
    fakeNetwork();
    const res = await handler(post(GENUINE_OTHER));
    assert.notEqual(res.status, 401);
    assert.ok(globalThis.__sb.from.includes('thoughts'));
    assert.deepEqual(globalThis.__sb.getUser, []);
  });

  test(`${name}: if Auth can't be reached, a token that isn't the exact key is refused`, async () => {
    const handler = await load(name);
    fakeNetwork({ authDown: true });
    assert.equal((await handler(post(GENUINE_OTHER))).status, 401);
    assert.deepEqual(globalThis.__sb.from, []);
  });
}

for (const name of ['daily-quiz', 'gap-questions']) {
  test(`${name}: the owner's app login stays in app mode (JSON, no Telegram, no Auth admin call)`, async () => {
    const handler = await load(name);
    const calls = fakeNetwork();
    const res = await handler(post(OWNER_LOGIN));
    assert.equal(res.status, 200);
    assert.deepEqual(globalThis.__sb.getUser, [`Bearer ${OWNER_LOGIN}`], 'checked as an app user');
    assert.ok(!calls.some((c) => c.url.includes('telegram')), 'nothing sent to Telegram');
    assert.ok(!calls.some((c) => c.url.includes('/auth/v1/admin')), 'login tokens never go to the admin check');
  });

  test(`${name}: someone else's real login is refused`, async () => {
    const handler = await load(name);
    fakeNetwork();
    const res = await handler(post(OTHER_LOGIN));
    assert.equal(res.status, 401, 'someone else signed in is refused');
    assert.deepEqual(globalThis.__sb.from, []);
  });

  test(`${name}: a made-up token gets nothing back made from notes`, async () => {
    const handler = await load(name);
    fakeNetwork();
    const res = await handler(post(FORGED[1], { course: 'FIN-451' }));
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.deepEqual(body, { error: 'Unauthorized' });
  });
}

test('weekly-digest: missing SUPABASE_ANON_KEY means only the exact key works (no Auth check possible)', async () => {
  const handler = await load('weekly-digest', { SUPABASE_ANON_KEY: undefined });
  fakeNetwork();
  assert.equal((await handler(post(GENUINE_OTHER))).status, 401);
  fakeNetwork();
  assert.notEqual((await handler(post(REAL_KEY))).status, 401);
});
