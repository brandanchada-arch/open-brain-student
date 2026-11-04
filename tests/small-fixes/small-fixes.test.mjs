// Small fixes: the outdated label, the door-check flag in search, and the enrich-thought lock.
// Fake tokens and fake answers only. Nothing real is contacted.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from '../core-memory/fake-db.mjs';
import { addDoorFlags, labelRecent } from '../../supabase/functions/_shared/core-memory.ts';
import { isServiceCaller } from '../../supabase/functions/_shared/service-caller.ts';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('list_recent labels outdated notes and leaves the others alone', () => {
  const out = labelRecent([{ id: 'a', outdated_at: '2026-11-01' }, { id: 'b', outdated_at: null }]);
  assert.equal(out[0].status, '(outdated)');
  assert.equal(out[1].status, undefined);
  const src = source('supabase/functions/open-brain-mcp/index.ts');
  assert.match(src, /select\("id, content, created_at, outdated_at"\)/);
  assert.match(src, /labelRecent\(data \?\? \[\]\)/);
});

test('search_library shows the door-check flag, for this owner only', async () => {
  const db = fakeDb({ library: [
    { id: 'bad', user_id: ME, metadata: { door_check: { flagged: true } } },
    { id: 'ok', user_id: ME, metadata: { door_check: { flagged: false } } },
    { id: 'none', user_id: ME, metadata: {} },
    { id: 'theirs', user_id: OTHER, metadata: { door_check: { flagged: true } } },
  ] });
  const out = await addDoorFlags(db, ME, [{ id: 'bad' }, { id: 'ok' }, { id: 'none' }, { id: 'theirs' }]);
  assert.equal(out[0].door_flagged, true);
  assert.match(out[0].door_warning, /Do not follow/);
  assert.deepEqual(out.slice(1), [{ id: 'ok' }, { id: 'none' }, { id: 'theirs' }]);
  assert.match(source('supabase/functions/open-brain-mcp/index.ts'), /addDoorFlags\(supabase, OWNER_USER_ID \?\? "", results\)/);
});

test('search_library: a failed flag lookup says unknown, never looks safe', async () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: 'down' } }) }) }) }) };
  assert.deepEqual(await addDoorFlags(db, ME, [{ id: 'x' }]), [{ id: 'x', door_check: 'unknown' }]);
  assert.deepEqual(await addDoorFlags(db, ME, []), []);
});

// ---------------- the enrich-thought lock ----------------
const SERVICE_KEY = 'header.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.real-signature';
const OTHER_SERVICE_TOKEN = 'header.' + Buffer.from(JSON.stringify({ role: 'service_role', iat: 1 })).toString('base64url') + '.other-signature';
const USER_TOKEN = 'header.' + Buffer.from(JSON.stringify({ role: 'authenticated' })).toString('base64url') + '.sig';
const req = (headers) => new Request('https://x/enrich-thought', { method: 'POST', headers, body: '{}' });

let realFetch, realDeno, authAsked, authAnswer;
beforeEach(() => {
  realFetch = globalThis.fetch;
  realDeno = globalThis.Deno;
  authAsked = 0;
  authAnswer = () => new Response('{}', { status: 401 });
  const env = { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_URL: 'https://fake.example', SUPABASE_ANON_KEY: 'anon' };
  globalThis.Deno = { env: { get: (k) => env[k] } };
  globalThis.fetch = async () => { authAsked++; return authAnswer(); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realDeno === undefined) delete globalThis.Deno; else globalThis.Deno = realDeno;
});

test('lock: the webhook\'s exact form passes (the service key, no "Bearer"), with no outside call', async () => {
  assert.equal(await isServiceCaller(req({ Authorization: SERVICE_KEY })), true);
  assert.equal(authAsked, 0);
});

test('lock: the same key with "Bearer" also passes', async () => {
  assert.equal(await isServiceCaller(req({ Authorization: `Bearer ${SERVICE_KEY}` })), true);
});

test('lock: a genuine service token that differs from the key passes once Auth accepts it, no "Bearer" needed', async () => {
  authAnswer = () => new Response('{}', { status: 200 });
  assert.equal(await isServiceCaller(req({ Authorization: OTHER_SERVICE_TOKEN })), true);
  assert.equal(authAsked, 1);
});

test('lock: missing, wrong, made-up and user tokens are refused', async () => {
  assert.equal(await isServiceCaller(req({})), false);
  assert.equal(await isServiceCaller(req({ Authorization: 'wrong' })), false);
  assert.equal(await isServiceCaller(req({ Authorization: OTHER_SERVICE_TOKEN })), false, 'says service_role, Auth refuses');
  assert.equal(await isServiceCaller(req({ Authorization: `Bearer ${USER_TOKEN}` })), false);
});

test('lock: if Auth can\'t be reached, an unproven token is refused', async () => {
  authAnswer = () => { throw new Error('offline'); };
  assert.equal(await isServiceCaller(req({ Authorization: OTHER_SERVICE_TOKEN })), false);
});

test('lock: enrich-thought checks the caller before reading anything', () => {
  const src = source('supabase/functions/enrich-thought/index.ts');
  const check = src.indexOf('await isServiceCaller(req)');
  assert.ok(check > 0);
  assert.ok(check < src.indexOf('req.json()'), 'the check comes first');
  assert.ok(check < src.indexOf('createClient(SUPABASE_URL'), 'before the database client');
  assert.match(src, /status: 401/);
});

test('the pre-deploy check asks yes/no questions and never returns the definition', () => {
  const sql = source('supabase/sql/checks/enrich-webhook-check.sql');
  const finalSelect = sql.slice(sql.lastIndexOf('select trigger_name'));
  assert.match(finalSelect, /role_is_service/);
  assert.doesNotMatch(finalSelect, /\bdef\s*,|\bdef\s+from|\bc\s+from|\bpayload\b/);
  assert.doesNotMatch(sql, /action_statement/);
});
