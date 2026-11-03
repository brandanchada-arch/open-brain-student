// Item 3 SQL: runs the real 2026-10-22 and 2026-11-03 files in PGlite (in-memory Postgres).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, asUser, addThought, ALICE, BOB } from './pg-setup.mjs';

const edit = (db, id, user, content = null, outdated = null, replacedBy = null) =>
  db.query('select * from save_thought_edit($1, $2, $3, $4, $5)', [id, user, content, outdated, replacedBy]).then((r) => r.rows[0]);

test('SQL file runs twice without errors (safe to re-run) and adds the shared columns', async () => {
  const db = await makeDb();
  const sql = (await import('node:fs')).readFileSync(new URL('../../supabase/sql/2026-11-03-ask-edit-check.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  const { rows } = await db.query(`select column_name, data_type from information_schema.columns
    where table_name = 'thoughts' and column_name in ('outdated_at', 'replaced_by') order by 1`);
  assert.deepEqual(rows.map((r) => r.column_name), ['outdated_at', 'replaced_by']);
  // Only one save_thought_edit, and still only one search_thoughts / find_links_for_thought (no new overloads).
  const { rows: fns } = await db.query(`select proname, count(*)::int n from pg_proc where proname in
    ('save_thought_edit', 'search_thoughts', 'find_links_for_thought') group by 1 order by 1`);
  assert.deepEqual(fns.map((f) => [f.proname, f.n]), [['find_links_for_thought', 1], ['save_thought_edit', 1], ['search_thoughts', 1]]);
});

test('works when the other session already added the same columns first', async () => {
  const db = await makeDb({ withNewSql: false });
  await db.exec(`alter table thoughts add column outdated_at timestamptz; alter table thoughts add column replaced_by uuid references thoughts(id);`);
  const sql = (await import('node:fs')).readFileSync(new URL('../../supabase/sql/2026-11-03-ask-edit-check.sql', import.meta.url), 'utf8');
  await db.exec(sql);
});

test('edit saves the old text to thought_versions and updates the thought', async () => {
  const db = await makeDb();
  const id = await addThought(db, ALICE, 'Made-up: the meeting is Monday', { embedding: '[1,0,0]', tags: ['meetings'], category: 'plan' });
  const other = await addThought(db, ALICE, 'Made-up other note', { embedding: '[1,0,0]' });
  await db.query(`insert into thought_chunks (thought_id, origin, chunk_index, content) values ($1, 'summary', 0, 'old chunk'), ($1, 'source', 0, 'source chunk')`, [id]);
  await db.query(`insert into thought_links (source_thought_id, target_thought_id, user_id) values ($1, $2, $3), ($2, $1, $3)`, [id, other, ALICE]);

  const r = await edit(db, id, ALICE, 'Made-up: the meeting moved to Tuesday');
  assert.equal(r.status, 'saved');
  assert.equal(r.content_changed, true);
  const { rows: [t] } = await db.query('select content, embedding, dedup_key = md5(content) as key_ok from thoughts where id = $1', [id]);
  assert.equal(t.content, 'Made-up: the meeting moved to Tuesday');
  assert.equal(t.embedding, null, 'embedding cleared so backfill-embeddings can repair it');
  assert.equal(t.key_ok, true, 'dedup trigger recalculated dedup_key');
  const { rows: v } = await db.query('select content, category, tags from thought_versions where thought_id = $1', [id]);
  assert.equal(v.length, 1);
  assert.equal(v[0].content, 'Made-up: the meeting is Monday');
  assert.equal(v[0].category, 'plan');
  const { rows: ch } = await db.query('select origin from thought_chunks where thought_id = $1', [id]);
  assert.deepEqual(ch.map((c) => c.origin), ['source'], "old summary chunks gone, 'source' chunks kept");
  const { rows: ln } = await db.query('select count(*)::int n from thought_links');
  assert.equal(ln[0].n, 0, 'stale semantic links removed so backfill-links relinks');
});

test('an edit that matches another note is refused, and nothing changes', async () => {
  const db = await makeDb();
  const a = await addThought(db, ALICE, 'Made-up note A');
  const b = await addThought(db, ALICE, 'Made-up note B');
  const r = await edit(db, a, ALICE, 'Made-up note B');
  assert.equal(r.status, 'duplicate');
  assert.equal(r.duplicate_id, b);
  assert.equal(r.duplicate_archived, false);
  const { rows } = await db.query('select content from thoughts where id = $1', [a]);
  assert.equal(rows[0].content, 'Made-up note A');
  const { rows: v } = await db.query('select count(*)::int n from thought_versions');
  assert.equal(v[0].n, 0, 'the version row was rolled back too');
});

test('the same text as SOMEONE ELSE’S note is fine (dedup is per user)', async () => {
  const db = await makeDb();
  await addThought(db, BOB, 'Same made-up text');
  const a = await addThought(db, ALICE, 'Different text');
  assert.equal((await edit(db, a, ALICE, 'Same made-up text')).status, 'saved');
});

test("cannot edit another user's or an archived thought", async () => {
  const db = await makeDb();
  const bobs = await addThought(db, BOB, 'Bob made-up note');
  assert.equal((await edit(db, bobs, ALICE, 'hacked')).status, 'not_found');
  const arch = await addThought(db, ALICE, 'Archived made-up note', { archived_at: new Date().toISOString() });
  assert.equal((await edit(db, arch, ALICE, 'changed')).status, 'not_found');
  const { rows } = await db.query('select content from thoughts where id = $1', [bobs]);
  assert.equal(rows[0].content, 'Bob made-up note');
});

test('mark outdated with a replacement, then undo; bad replacements refused', async () => {
  const db = await makeDb();
  const old = await addThought(db, ALICE, 'Made-up old plan');
  const neu = await addThought(db, ALICE, 'Made-up new plan');
  const bobs = await addThought(db, BOB, 'Bob made-up');
  assert.equal((await edit(db, old, ALICE, null, true, bobs)).status, 'bad_replacement');
  assert.equal((await edit(db, old, ALICE, null, true, old)).status, 'bad_replacement');
  const r = await edit(db, old, ALICE, null, true, neu);
  assert.equal(r.status, 'saved');
  assert.equal(r.content_changed, false);
  let { rows: [t] } = await db.query('select outdated_at, replaced_by from thoughts where id = $1', [old]);
  assert.ok(t.outdated_at);
  assert.equal(t.replaced_by, neu);
  // A loop (new replaced by old, while old is replaced by new) is refused.
  assert.equal((await edit(db, neu, ALICE, null, true, old)).status, 'bad_replacement');
  await edit(db, old, ALICE, null, false);
  ({ rows: [t] } = await db.query('select outdated_at, replaced_by from thoughts where id = $1', [old]));
  assert.equal(t.outdated_at, null);
  assert.equal(t.replaced_by, null);
  const { rows: v } = await db.query('select count(*)::int n from thought_versions');
  assert.equal(v[0].n, 0, 'marking outdated does not make a version');
});

test('thought_versions: owner can read, others cannot, browser cannot write; save_thought_edit not callable from the browser', async () => {
  const db = await makeDb();
  const id = await addThought(db, ALICE, 'Made-up v1');
  await edit(db, id, ALICE, 'Made-up v2');
  const mine = await asUser(db, ALICE, () => db.query('select content from thought_versions'));
  assert.equal(mine.rows.length, 1);
  const theirs = await asUser(db, BOB, () => db.query('select content from thought_versions'));
  assert.equal(theirs.rows.length, 0);
  await assert.rejects(() => asUser(db, ALICE, () =>
    db.query(`insert into thought_versions (thought_id, user_id, content) values ($1, $2, 'fake')`, [id, ALICE])));
  await assert.rejects(() => asUser(db, ALICE, () => edit(db, id, ALICE, 'via browser')));
});

test('search_thoughts: outdated notes rank lower but are still found', async () => {
  const db = await makeDb();
  const old = await addThought(db, ALICE, 'budget plan budget plan budget plan', { embedding: '[1,0,0]' });
  const neu = await addThought(db, ALICE, 'budget plan for the trip', { embedding: '[0.9,0.1,0]' });
  const run = () => db.query(`select id from search_thoughts('budget plan', $1, '[1,0,0]'::vector, 0.3, 10)`, [ALICE]).then((r) => r.rows.map((x) => x.id));
  assert.deepEqual(await run(), [old, neu], 'before: the old one is the best match');
  await edit(db, old, ALICE, null, true, neu);
  assert.deepEqual(await run(), [neu, old], 'after: outdated drops below, still listed');
});

test('find_links_for_thought skips outdated notes', async () => {
  const db = await makeDb();
  const src = await addThought(db, ALICE, 'source', { embedding: '[1,0,0]' });
  const a = await addThought(db, ALICE, 'near a', { embedding: '[1,0.01,0]' });
  const b = await addThought(db, ALICE, 'near b', { embedding: '[1,0.02,0]' });
  await edit(db, a, ALICE, null, true);
  const { rows } = await db.query(`select target_id from find_links_for_thought($1, '[1,0,0]'::vector, $2, 0.5, 5)`, [src, ALICE]);
  assert.deepEqual(rows.map((r) => r.target_id), [b]);
});
