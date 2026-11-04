// SQL tests for supabase/sql/2026-11-03-core-memory.sql, run in PGlite (Postgres in memory).
// Run: npm i --no-save @electric-sql/pglite   then   node --test tests/core-memory/
// Users and ids below are made up.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SQL_FILE = new URL('../../supabase/sql/2026-11-03-core-memory.sql', import.meta.url);
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let db;

// A tiny stand-in for Supabase: roles, auth.users, auth.uid(), a thoughts table,
// and Supabase's default grants (so RLS is the only thing protecting rows).
const SUPABASE_STUB = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.thoughts (id uuid primary key default gen_random_uuid(), user_id uuid, content text);
  insert into auth.users values ('${ME}'), ('${OTHER}');
`;
const DEFAULT_GRANTS = `
  grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
`;

async function asUser(uid, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

async function addProposal(user, slug, text, extra = {}) {
  return (await one(
    `insert into brain_proposals (user_id, target_slug, proposed_text, reason, source_ids, sensitive)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [user, slug, text, extra.reason ?? 'test', JSON.stringify(extra.sources ?? []), extra.sensitive ?? false],
  )).id;
}

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const sql = readFileSync(SQL_FILE, 'utf8');
  await db.exec(sql);
  await db.exec(sql); // safe to run twice
  await db.exec(DEFAULT_GRANTS);
});

test('seeds four empty pages per user, once', async () => {
  const r = await db.query(`select slug, current_text, history_text from brain_pages where user_id = $1 order by slug`, [ME]);
  assert.deepEqual(r.rows.map(x => x.slug), ['core', 'courses', 'job-search', 'mega']);
  assert.ok(r.rows.every(x => x.current_text === '' && x.history_text === ''));
  assert.equal((await one(`select count(*)::int n from brain_pages`)).n, 8);
});

test('thoughts got outdated_at and replaced_by, and re-adding them is harmless', async () => {
  await db.exec(`alter table public.thoughts add column if not exists outdated_at timestamptz;`);
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'thoughts'`)).rows.map(r => r.column_name);
  assert.ok(cols.includes('outdated_at') && cols.includes('replaced_by'));
});

test('RLS: owner reads own pages and proposals, not someone else\'s', async () => {
  await addProposal(OTHER, 'core', 'Other person core');
  const mine = await asUser(ME, () => db.query(`select user_id from brain_pages`));
  assert.ok(mine.rows.length === 4 && mine.rows.every(r => r.user_id === ME));
  const props = await asUser(ME, () => db.query(`select * from brain_proposals`));
  assert.equal(props.rows.length, 0);
});

test('RLS: signed-in users cannot write pages, proposals or session logs directly', async () => {
  await asUser(ME, async () => {
    const upd = await db.query(`update brain_pages set current_text = 'hacked' where user_id = '${ME}' returning id`);
    assert.equal(upd.rows.length, 0); // no update policy, so nothing matches
    await assert.rejects(db.query(`insert into brain_proposals (user_id, target_slug, proposed_text) values ('${ME}', 'core', 'x')`));
    await assert.rejects(db.query(`insert into session_logs (user_id, title, summary) values ('${ME}', 't', 's')`));
    const logs = await db.query(`select * from session_logs`);
    assert.equal(logs.rows.length, 0);
  });
});

test('signed-in users cannot call approve / reject / undo', async () => {
  const id = await addProposal(ME, 'core', 'x');
  await asUser(ME, async () => {
    await assert.rejects(db.query(`select approve_brain_proposal($1, $2)`, [ME, id]), /permission denied/);
    await assert.rejects(db.query(`select reject_brain_proposal($1, $2)`, [ME, id]), /permission denied/);
    await assert.rejects(db.query(`select undo_brain_page_change($1)`, [ME]), /permission denied/);
  });
  await db.query(`select reject_brain_proposal($1, $2)`, [ME, id]);
});

test('approve replaces Current, older Current moves to the top of History, History only grows', async () => {
  const a = await addProposal(ME, 'job-search', 'Applying to analyst roles.');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, a]);
  let page = await one(`select * from brain_pages where user_id = $1 and slug = 'job-search'`, [ME]);
  assert.equal(page.current_text, 'Applying to analyst roles.');
  assert.equal(page.history_text, ''); // the page was empty before, nothing to keep

  const b = await addProposal(ME, 'job-search', 'Two interviews booked.');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, b]);
  page = await one(`select * from brain_pages where user_id = $1 and slug = 'job-search'`, [ME]);
  assert.equal(page.current_text, 'Two interviews booked.');
  assert.match(page.history_text, /^### Until \d{4}-\d{2}-\d{2}\nApplying to analyst roles\.$/);

  const c = await addProposal(ME, 'job-search', 'Offer received.');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, c]);
  page = await one(`select * from brain_pages where user_id = $1 and slug = 'job-search'`, [ME]);
  assert.ok(page.history_text.indexOf('Two interviews') < page.history_text.indexOf('Applying to analyst'));
  const status = await one(`select status, reviewed_at from brain_proposals where id = $1`, [c]);
  assert.equal(status.status, 'approved');
  assert.ok(status.reviewed_at);
});

test('cannot approve twice, approve someone else\'s proposal, or approve a rejected one', async () => {
  const a = await addProposal(ME, 'courses', 'FIN class');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, a]);
  await assert.rejects(db.query(`select approve_brain_proposal($1, $2)`, [ME, a]), /already approved/);
  const theirs = await addProposal(OTHER, 'courses', 'Theirs');
  await assert.rejects(db.query(`select approve_brain_proposal($1, $2)`, [ME, theirs]), /not found/);
  await assert.rejects(db.query(`select reject_brain_proposal($1, $2)`, [ME, theirs]), /not found/);
  const r = await addProposal(ME, 'courses', 'Nope');
  await db.query(`select reject_brain_proposal($1, $2)`, [ME, r]);
  await assert.rejects(db.query(`select approve_brain_proposal($1, $2)`, [ME, r]), /already rejected/);
});

test('core page refuses text over 4000 characters', async () => {
  const id = await addProposal(ME, 'core', 'x'.repeat(4001));
  await assert.rejects(db.query(`select approve_brain_proposal($1, $2)`, [ME, id]), /too long/);
  assert.equal((await one(`select status from brain_proposals where id = $1`, [id])).status, 'pending');
  await db.query(`select reject_brain_proposal($1, $2)`, [ME, id]);
});

test('undo puts back the last change, one step at a time, and only for this user', async () => {
  const before = await one(`select current_text, history_text from brain_pages where user_id = $1 and slug = 'mega'`, [ME]);
  const a = await addProposal(ME, 'mega', 'Round 1 plan');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, a]);
  const b = await addProposal(ME, 'mega', 'Round 2 plan');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, b]);

  // The other user has nothing to undo, and can't undo mine.
  await assert.rejects(db.query(`select undo_brain_page_change($1)`, [OTHER]), /Nothing to undo/);

  await db.query(`select undo_brain_page_change($1)`, [ME]);
  let page = await one(`select * from brain_pages where user_id = $1 and slug = 'mega'`, [ME]);
  assert.equal(page.current_text, 'Round 1 plan');
  assert.equal(page.history_text, before.history_text);
  assert.equal((await one(`select status from brain_proposals where id = $1`, [b])).status, 'rejected');

  await db.query(`select undo_brain_page_change($1)`, [ME]);
  page = await one(`select * from brain_pages where user_id = $1 and slug = 'mega'`, [ME]);
  assert.equal(page.current_text, before.current_text);
});

test('topic page History can never shrink by a direct update (even as service role), only by undo', async () => {
  const a = await addProposal(ME, 'courses', 'Week 1 notes');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, a]);
  const b = await addProposal(ME, 'courses', 'Week 2 notes');
  await db.query(`select approve_brain_proposal($1, $2)`, [ME, b]);
  const page = await one(`select history_text from brain_pages where user_id = $1 and slug = 'courses'`, [ME]);
  assert.ok(page.history_text.length > 0);
  await assert.rejects(
    db.query(`update brain_pages set history_text = '' where user_id = $1 and slug = 'courses'`, [ME]),
    /can only grow/,
  );
  await assert.rejects(
    db.query(`update brain_pages set history_text = 'rewritten' where user_id = $1 and slug = 'courses'`, [ME]),
    /can only grow/,
  );
  // Adding on top is fine; changing Current alone is fine.
  await db.query(`update brain_pages set history_text = 'newer entry' || E'\\n\\n' || history_text where user_id = $1 and slug = 'courses'`, [ME]);
  await db.query(`update brain_pages set current_text = 'edited' where user_id = $1 and slug = 'courses'`, [ME]);
  // Undo still works (it is allowed to put the older history back), and the switch is off again afterwards.
  await db.query(`select undo_brain_page_change($1)`, [ME]);
  await assert.rejects(
    db.query(`update brain_pages set history_text = '' where user_id = $1 and slug = 'courses'`, [ME]),
    /can only grow/,
  );
});

test('session_logs refuses long summaries (no transcripts)', async () => {
  await db.query(`insert into session_logs (user_id, title, summary) values ($1, 'ok', 'short')`, [ME]);
  await assert.rejects(db.query(`insert into session_logs (user_id, title, summary) values ($1, 't', $2)`, [ME, 'x'.repeat(2001)]));
});

test('proposal status must be pending, approved or rejected', async () => {
  await assert.rejects(db.query(
    `insert into brain_proposals (user_id, target_slug, proposed_text, status) values ($1, 'core', 'x', 'maybe')`, [ME]));
});
