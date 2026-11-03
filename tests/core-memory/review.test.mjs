// Tests for review-proposal (handler.ts) with a fake login check and a fake database.
// Users and ids below are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleReview } from '../../supabase/functions/review-proposal/handler.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROP = '33333333-3333-4333-8333-333333333333';
const GOOD_TOKEN = 'Bearer good-token';

function deps({ rpcResult = { data: { ok: true, slug: 'core' }, error: null } } = {}) {
  const calls = [];
  return {
    calls,
    getUser: async (h) => (h === GOOD_TOKEN ? { id: ME } : null),
    admin: { rpc: async (name, args) => { calls.push({ name, args }); return typeof rpcResult === 'function' ? rpcResult(name, args) : rpcResult; } },
  };
}

const post = (body, auth = GOOD_TOKEN) => new Request('http://local/review-proposal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('no token or a bad token → 401 and nothing is touched', async () => {
  for (const auth of [null, 'Bearer bad-token', 'not-a-bearer']) {
    const d = deps();
    const r = await handleReview(post({ action: 'approve', id: PROP }, auth), d);
    assert.equal(r.status, 401, String(auth));
    assert.equal(d.calls.length, 0);
  }
});

test('getUser throwing counts as not signed in', async () => {
  const d = deps();
  d.getUser = async () => { throw new Error('network'); };
  const r = await handleReview(post({ action: 'undo' }), d);
  assert.equal(r.status, 401);
  assert.equal(d.calls.length, 0);
});

test('user_id in the body is ignored: the token user is used', async () => {
  const d = deps();
  const r = await handleReview(post({ action: 'approve', id: PROP, user_id: OTHER, p_user_id: OTHER }), d);
  assert.equal(r.status, 200);
  assert.deepEqual(d.calls, [{ name: 'approve_brain_proposal', args: { p_user_id: ME, p_proposal_id: PROP } }]);
  assert.deepEqual(await r.json(), { ok: true, action: 'approve', slug: 'core' });
});

test('reject and undo call the right database functions', async () => {
  const d = deps();
  assert.equal((await handleReview(post({ action: 'reject', id: PROP }), d)).status, 200);
  assert.equal((await handleReview(post({ action: 'undo', id: 'ignored', user_id: OTHER }), d)).status, 200);
  assert.deepEqual(d.calls, [
    { name: 'reject_brain_proposal', args: { p_user_id: ME, p_proposal_id: PROP } },
    { name: 'undo_brain_page_change', args: { p_user_id: ME } },
  ]);
});

test('bad action → 400', async () => {
  for (const body of [{ action: 'delete', id: PROP }, { id: PROP }, { action: 'APPROVE', id: PROP }, [], 'not json', null]) {
    const d = deps();
    const r = await handleReview(post(body), d);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(d.calls.length, 0);
  }
});

test('id must be a uuid for approve / reject', async () => {
  for (const id of [undefined, '', 'abc', 42, `${PROP}' or 1=1 --`, { id: PROP }]) {
    const d = deps();
    const r = await handleReview(post({ action: 'approve', id }), d);
    assert.equal(r.status, 400, JSON.stringify(id));
    assert.equal(d.calls.length, 0);
  }
});

test('database errors become plain messages with fitting status codes', async () => {
  const cases = [
    ['Proposal not found', 404],
    ['Proposal was already approved', 409],
    ['Nothing to undo', 409],
    ['Core page text is too long (5000 characters, limit 4000)', 422],
    ['permission denied for function', 500],
  ];
  for (const [message, status] of cases) {
    const d = deps({ rpcResult: { data: null, error: { message } } });
    const r = await handleReview(post({ action: message === 'Nothing to undo' ? 'undo' : 'approve', id: PROP }), d);
    assert.equal(r.status, status, message);
    const j = await r.json();
    assert.equal(j.ok, false);
    if (status === 500) assert.doesNotMatch(j.error, /permission/); // internal details not shown
  }
});

test('CORS: OPTIONS answers, every reply carries the CORS header; GET refused', async () => {
  const d = deps();
  const pre = await handleReview(new Request('http://local/x', { method: 'OPTIONS' }), d);
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
  const bad = await handleReview(post({ action: 'x' }, null), d);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), '*');
  const get = await handleReview(new Request('http://local/x', { method: 'GET', headers: { Authorization: GOOD_TOKEN } }), d);
  assert.equal(get.status, 405);
});

test('index.ts gets the user from the token with the anon key, not the body', () => {
  const src = readFileSync(new URL('../../supabase/functions/review-proposal/index.ts', import.meta.url), 'utf8');
  assert.match(src, /SUPABASE_ANON_KEY/);
  assert.match(src, /auth\.getUser\(\)/);
  assert.doesNotMatch(src, /req\.json|body\.user/);
});
