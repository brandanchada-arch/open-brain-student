// Brain health check: the SQL in PGlite (Postgres in memory), plus the review-proposal action,
// the export heartbeat and the app card. Everything is made up; nothing real is touched.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { handleReview } from '../../supabase/functions/review-proposal/handler.ts';
import { handleExport } from '../../supabase/functions/export-brain/handler.ts';

const SQL = readFileSync(new URL('../../supabase/sql/2026-11-04-brain-health.sql', import.meta.url), 'utf8');
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-20T12:00:00Z';

let db;
const ago = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();

async function health(user = ME) {
  const { rows } = await db.query('select public.brain_health($1, $2) as h', [user, NOW]);
  return rows[0].h;
}
const codes = (h) => h.problems.map((p) => p.code);

async function addThought(user, extra = {}) {
  const t = { content: 'A note long enough to be tagged by the AI', embedding: '[1]', enriched_at: ago(1), category: 'idea', created_at: ago(3), ...extra };
  const cols = Object.keys(t);
  const { rows } = await db.query(
    `insert into thoughts (user_id, ${cols.join(',')}) values ($1, ${cols.map((_, i) => '$' + (i + 2)).join(',')}) returning id`,
    [user, ...Object.values(t)],
  );
  return rows[0].id;
}
async function addJob(name, lastRun, status = 'succeeded', active = true) {
  const { rows } = await db.query('insert into cron.job (jobname, active) values ($1, $2) returning jobid', [name, active]);
  if (lastRun) await db.query('insert into cron.job_run_details (jobid, start_time, status) values ($1, $2, $3)', [rows[0].jobid, lastRun, status]);
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema cron;
    grant usage on schema cron to service_role;
    create table cron.job (jobid serial primary key, jobname text, active boolean);
    create table cron.job_run_details (jobid int, start_time timestamptz, status text);
    create table thoughts (id uuid primary key default gen_random_uuid(), user_id uuid, content text, embedding text,
      enriched_at timestamptz, category text, created_at timestamptz default now(), archived_at timestamptz, outdated_at timestamptz);
    create table library (id uuid primary key default gen_random_uuid(), user_id uuid, embedding text, metadata jsonb default '{}', created_at timestamptz default now());
    create table thought_chunks (id uuid primary key default gen_random_uuid(), thought_id uuid, embedding text, created_at timestamptz default now());
    create table library_chunks (id uuid primary key default gen_random_uuid(), library_id uuid, embedding text, created_at timestamptz default now());
    create table thought_links (id uuid primary key default gen_random_uuid(), source_thought_id uuid, target_thought_id uuid, created_at timestamptz default now());
    create table thought_versions (id uuid primary key default gen_random_uuid(), thought_id uuid, edited_at timestamptz default now());
    create table brain_proposals (id uuid primary key default gen_random_uuid(), user_id uuid, status text);
  `);
  await db.exec(SQL);
  await db.exec(SQL); // safe to run twice
  await db.exec('grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;');
  await db.exec(SQL); // and it takes back what Supabase's default grants give
});

beforeEach(async () => {
  await db.exec(`truncate cron.job, cron.job_run_details, thoughts, library, thought_chunks, library_chunks,
    thought_links, thought_versions, brain_proposals, health_heartbeats;`);
});

test('a healthy brain has no problems', async () => {
  await addThought(ME);
  await addJob('weekly-brain-digest', ago(3));
  await addJob('keep-brain-awake', ago(4));
  const h = await health();
  assert.equal(h.ok, true);
  assert.deepEqual(h.problems, []);
});

test('scheduled jobs: overdue, failed and switched off are problems; never-run is not', async () => {
  await addJob('keep-brain-awake', ago(5));
  await addJob('weekly-brain-digest', ago(9));
  await addJob('weekly-brain-condenser', ago(2), 'failed');
  await addJob('weekly-news-filter', null);
  await addJob('brain-calendar-tick', ago(0), 'succeeded', false);
  await addJob('someone-elses-job', ago(100));
  const h = await health();
  assert.deepEqual(codes(h).sort(), [
    'job_failed:weekly-brain-condenser', 'job_off:brain-calendar-tick',
    'job_overdue:keep-brain-awake', 'job_overdue:weekly-brain-digest',
  ]);
  assert.equal(h.ok, false);
});

test('no false alarm: one failed tick, or a job created switched off that never ran', async () => {
  await addJob('brain-calendar-tick', ago(1 / 1440), 'failed');
  await addJob('weekly-news-filter', null, 'succeeded', false);
  assert.deepEqual(codes(await health()), []);
});

test('a job on time, right at its limit, is not a false alarm', async () => {
  await addJob('keep-brain-awake', ago(4));
  await addJob('weekly-brain-digest', ago(7.9));
  await addJob('brain-calendar-tick', ago(10 / 1440));
  assert.deepEqual(codes(await health()), []);
});

test('missing embeddings count only after an hour, and only for this user', async () => {
  const old = await addThought(ME, { embedding: null });
  await addThought(ME, { embedding: null, created_at: ago(0.01) });
  await addThought(OTHER, { embedding: null });
  await addThought(ME, { embedding: null, archived_at: ago(1) });
  await db.query('insert into thought_chunks (thought_id, embedding, created_at) values ($1, null, $2)', [old, ago(1)]);
  const { rows } = await db.query('insert into library (user_id, embedding, created_at) values ($1, null, $2) returning id', [ME, ago(1)]);
  await db.query('insert into library_chunks (library_id, embedding, created_at) values ($1, null, $2)', [rows[0].id, ago(1)]);
  const h = await health();
  assert.deepEqual(codes(h).sort(), ['library_chunks', 'library_embeddings', 'thought_chunks', 'thought_embeddings']);
  assert.match(h.problems.find((p) => p.code === 'thought_embeddings').text, /^1 note/);
});

test('untagged: new notes are a problem; short, categorized, too-fresh and old ones are not', async () => {
  await addThought(ME, { enriched_at: null, category: null, created_at: ago(2) });
  await addThought(ME, { enriched_at: null, category: null, created_at: ago(0.5) }); // too fresh
  await addThought(ME, { enriched_at: null, category: null, content: 'short', created_at: ago(2) }); // skipped on purpose
  await addThought(ME, { enriched_at: null, category: 'digest', created_at: ago(2) }); // skipped on purpose
  await addThought(ME, { enriched_at: null, category: null, created_at: ago(30) }); // older = info only
  const h = await health();
  assert.deepEqual(codes(h), ['untagged_new']);
  assert.match(h.problems[0].text, /^1 new note/);
  assert.equal(h.info.older_untagged, 1);
});

test('PC backup: over 8 days is a problem; no heartbeat yet is not', async () => {
  assert.deepEqual(codes(await health()), []);
  await db.query(`insert into health_heartbeats (name, last_ok_at) values ('pc-backup', $1)`, [ago(9)]);
  assert.deepEqual(codes(await health()), ['backup_overdue']);
  await db.query(`update health_heartbeats set last_ok_at = $1`, [ago(7)]);
  assert.deepEqual(codes(await health()), []);
});

test('flagged, stale and waiting are info only, never problems', async () => {
  await db.query(`insert into library (user_id, embedding, metadata) values ($1, '[1]', '{"door_check":{"flagged":true}}'), ($1, '[1]', '{"door_check":{"flagged":false}}'), ($2, '[1]', '{"door_check":{"flagged":true}}')`, [ME, OTHER]);
  await db.query(`insert into brain_proposals (user_id, status) values ($1, 'pending'), ($1, 'approved'), ($2, 'pending')`, [ME, OTHER]);
  const stale = await addThought(ME, { created_at: ago(61) });
  assert.ok(stale);
  const h = await health();
  assert.equal(h.ok, true);
  assert.deepEqual(h.info, { flagged_library: 1, stale_notes: 1, older_untagged: 0, proposals_waiting: 1 });
});

test('stale means 60 days with no edit and no new link, and not already outdated', async () => {
  await addThought(ME, { created_at: ago(61) }); // stale
  await addThought(ME, { created_at: ago(59) }); // too young
  await addThought(ME, { created_at: ago(61), outdated_at: ago(1) }); // already dealt with
  const edited = await addThought(ME, { created_at: ago(61) });
  await db.query('insert into thought_versions (thought_id, edited_at) values ($1, $2)', [edited, ago(10)]);
  const linked = await addThought(ME, { created_at: ago(61) });
  await db.query('insert into thought_links (source_thought_id, target_thought_id, created_at) values ($1, $2, $3)', [edited, linked, ago(10)]);
  const oldLink = await addThought(ME, { created_at: ago(61) }); // an old link doesn't save it: stale
  await db.query('insert into thought_links (source_thought_id, target_thought_id, created_at) values ($1, $1, $2)', [oldLink, ago(70)]);
  assert.equal((await health()).info.stale_notes, 2);
});

test('only the server can call it: signed-in and anonymous users are refused', async () => {
  for (const role of ['authenticated', 'anon']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(() => db.query('select public.brain_health($1)', [ME]), /permission denied/);
    await assert.rejects(() => db.query('select * from public.health_heartbeats'), /permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  const { rows } = await db.query('select public.brain_health($1) as h', [ME]);
  await db.exec('reset role');
  assert.equal(rows[0].h.ok, true);
});

test('never returns note text', async () => {
  await addThought(ME, { content: 'SECRET-WORDS in a note with no embedding', embedding: null });
  assert.doesNotMatch(JSON.stringify(await health()), /SECRET-WORDS/);
});

// ---------------- review-proposal: the card's way in ----------------

const reviewReq = (body, token = 'Bearer abc') => new Request('https://x/review', {
  method: 'POST', headers: token ? { Authorization: token } : {}, body: JSON.stringify(body),
});
const reviewDeps = (rpc) => ({ getUser: async () => ({ id: ME }), admin: { rpc } });

test('health action: asks for the login token\'s user, ignoring any id in the body', async () => {
  let args;
  const res = await handleReview(reviewReq({ action: 'health', user_id: OTHER, p_user: OTHER }), reviewDeps(async (name, a) => {
    args = [name, a];
    return { data: { ok: true, problems: [] }, error: null };
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(args, ['brain_health', { p_user: ME }]);
  assert.equal((await res.json()).health.ok, true);
});

test('health action: not signed in is refused, and a database error is reported plainly', async () => {
  const called = [];
  const noUser = await handleReview(reviewReq({ action: 'health' }, null), reviewDeps(async () => called.push(1)));
  assert.equal(noUser.status, 401);
  assert.equal(called.length, 0);
  const broken = await handleReview(reviewReq({ action: 'health' }), reviewDeps(async () => ({ data: null, error: { message: 'boom secret detail' } })));
  assert.equal(broken.status, 500);
  assert.doesNotMatch(await broken.text(), /boom/);
});

// ---------------- export-brain: the backup heartbeat ----------------

function exportDb({ heartbeat = () => ({ error: null }) } = {}) {
  const notes = [];
  const chain = (rows) => {
    const q = { select: () => q, eq: () => q, gt: () => q, in: () => q, is: () => q, order: () => q, limit: () => Promise.resolve({ data: rows, error: null }),
      then: (ok) => Promise.resolve({ data: rows, error: null }).then(ok) };
    return q;
  };
  return { notes, from: (t) => t === 'health_heartbeats'
    ? { upsert: async (row) => { notes.push(row); return heartbeat(); } }
    : chain([]) };
}
const exportReq = (table) => new Request('https://x/export', {
  method: 'POST', headers: { Authorization: 'Bearer key' }, body: JSON.stringify({ table }),
});

test('a finished backup leaves a heartbeat; other tables do not', async () => {
  const db2 = exportDb();
  const deps = { db: db2, accessKey: 'key', ownerId: ME };
  await handleExport(exportReq('thoughts'), deps);
  assert.equal(db2.notes.length, 0);
  const res = await handleExport(exportReq('library_links'), deps);
  assert.equal((await res.json()).done, true);
  assert.equal(db2.notes.length, 1);
  assert.equal(db2.notes[0].name, 'pc-backup');
});

test('a heartbeat that fails never breaks the backup', async () => {
  for (const heartbeat of [() => ({ error: { message: 'no such table' } }), () => { throw new Error('down'); }]) {
    const res = await handleExport(exportReq('library_links'), { db: exportDb({ heartbeat }), accessKey: 'key', ownerId: ME });
    assert.equal(res.status, 200);
  }
});

// ---------------- wiring ----------------

test('the MCP server offers brain_health, filtered to the owner', () => {
  const src = readFileSync(new URL('../../supabase/functions/open-brain-mcp/index.ts', import.meta.url), 'utf8');
  assert.match(src, /name: "brain_health"/);
  assert.match(src, /rpc\("brain_health", \{ p_user: OWNER_USER_ID \}\)/);
});

test('the card escapes what it shows and fails quietly', () => {
  const src = readFileSync(new URL('../../review.js', import.meta.url), 'utf8');
  assert.match(src, /⚠ \$\{esc\(p\.text\)\}/);
  assert.match(src, /catch \{ \$\('rvHealth'\)\.innerHTML = ''; \}/);
});
