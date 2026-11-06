// Tests for About Brandan notes, core drop-offs, stale focus lines and deeper gap questions.
// Everything here is faked: nothing real is contacted. Users and ids are made up.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import {
  addSessionLog, buildCondenserPrompt, cleanAboutNotes, cleanProposals, mergeLineChanges, onlyRemovesLines,
  recentSessions, staleFocusLines,
} from '../../supabase/functions/_shared/core-memory.ts';
import { GAP_SYSTEM_PROMPT, pickGapNotes } from '../../supabase/functions/_shared/gap-prompt.ts';

const require = createRequire(import.meta.url);
const w = require('../../pc-setup/scripts/session-log-worker.js');
const { parseAboutMe, parseSummary } = w;

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-05T12:00:00Z');
let db;

const sqlFile = (name) => readFileSync(new URL(`../../supabase/sql/${name}`, import.meta.url), 'utf8');
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;

async function asUser(uid, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

async function approve(text, reason = 'test reason') {
  const { id } = await one(
    `insert into brain_proposals (user_id, target_slug, proposed_text, reason, source_ids, sensitive)
     values ($1, 'core', $2, $3, '[]', false) returning id`, [ME, text, reason]);
  await one('select approve_brain_proposal($1, $2)', [ME, id]);
  return id;
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.thoughts (id uuid primary key default gen_random_uuid(), user_id uuid, content text);
    insert into auth.users values ('${ME}'), ('${OTHER}');
  `);
  await db.exec(sqlFile('2026-11-03-core-memory.sql'));
  await db.exec(sqlFile('2026-11-05-about-me.sql'));
  await db.exec(sqlFile('2026-11-05-about-me.sql')); // safe to run twice
});

test('a line leaving core is logged with its reason; headings and new dates are not', async () => {
  await approve('## Current focus\n- [last mentioned 2026-10-01] Job search\n- [last mentioned 2026-10-01] Old project\n## What\'s true now\n- I struggle with X');
  assert.equal((await all('select * from core_dropped_items')).length, 0);

  await approve('## Current focus\n- [last mentioned 2026-11-05] Job search\n## What\'s true now\n- I grew out of X', 'Project finished');
  const rows = await all('select item, reason from core_dropped_items');
  assert.deepEqual(rows.map((r) => r.item).sort(), ['- I struggle with X', '- [last mentioned 2026-10-01] Old project'].sort());
  assert.equal(rows[0].reason, 'Project finished');
});

test('a line the AI says was only reworded is not logged as dropped', async () => {
  await approve('## Who\n- Old wording here\n- Really leaving');
  const count = async () => (await all('select item from core_dropped_items')).map((r) => r.item);
  const before = await count();
  const { id } = await one(
    `insert into brain_proposals (user_id, target_slug, proposed_text, reason, source_ids, sensitive, reworded)
     values ($1, 'core', $2, 'r', '[]', false, $3) returning id`,
    [ME, '## Who\n- New wording here', JSON.stringify(['- Old wording here'])]);
  await one('select approve_brain_proposal($1, $2)', [ME, id]);
  const added = (await count()).filter((x) => !before.includes(x));
  assert.deepEqual(added, ['- Really leaving']);
});

test('approving a change that waited keeps updates made since', () => {
  const base = '## Current focus\n- [last mentioned 2026-10-01] Job search\n## True\nI like plans.';
  const proposed = '## Current focus\n- [last mentioned 2026-10-01] Job search\n## True\nI like plans.\nStarted going to church.';
  const current = '## Current focus\n- [last mentioned 2026-11-01] Job search\n- [last mentioned 2026-11-01] New project\n## True\nI like plans.';
  assert.equal(mergeLineChanges(current, base, proposed),
    '## Current focus\n- [last mentioned 2026-11-01] Job search\n- [last mentioned 2026-11-01] New project\n## True\nI like plans.\nStarted going to church.');

  const removesLine = mergeLineChanges('## T\nKeep\nGone\nNew since', '## T\nKeep\nGone', '## T\nKeep');
  assert.equal(removesLine, '## T\nKeep\nNew since');
  assert.equal(mergeLineChanges('Only line', '', '## Fresh\nAdded'), 'Only line\n## Fresh\nAdded');
});

test('undo clears the drop-offs from the change it reverses', async () => {
  const before = (await all('select id from core_dropped_items')).length;
  await approve('## Current focus\n- [last mentioned 2026-11-05] Job search');
  assert.ok((await all('select id from core_dropped_items')).length > before);
  await one('select undo_brain_page_change($1)', [ME]);
  assert.equal((await all('select id from core_dropped_items')).length, before);
});

test('the owner reads and deletes only their own notes, and cannot add or edit them', async () => {
  await db.query(`insert into about_me_notes (user_id, note) values ($1, 'mine'), ($2, 'theirs')`, [ME, OTHER]);
  const seen = await asUser(ME, () => all('select note from about_me_notes'));
  assert.deepEqual(seen.map((r) => r.note), ['mine']);
  await assert.rejects(asUser(ME, () => db.query(`insert into about_me_notes (user_id, note) values ($1, 'x')`, [ME])));
  await asUser(ME, () => db.query('delete from about_me_notes'));
  assert.deepEqual((await all('select note from about_me_notes')).map((r) => r.note), ['theirs']);
});

test('the owner can read drop-offs but not change them, and others see none', async () => {
  const mine = (await all('select id from core_dropped_items')).length;
  assert.ok(mine > 0);
  assert.equal((await asUser(OTHER, () => all('select id from core_dropped_items'))).length, 0);
  assert.equal((await asUser(ME, () => all('select id from core_dropped_items'))).length, mine);
  await assert.rejects(asUser(ME, () => db.query('delete from core_dropped_items')));
});

test('staleFocusLines finds lines at 21 days or older', () => {
  const page = '- [last mentioned 2026-10-15] exactly 21 days\n- [last mentioned 2026-10-16] 20 days\n- no date stays';
  assert.deepEqual(staleFocusLines(page, NOW), ['- [last mentioned 2026-10-15] exactly 21 days']);
});

test('a core proposal needs no source only when it purely removes stale lines', () => {
  const pages = { core: '## Current focus\n- [last mentioned 2026-10-01] Old\n- [last mentioned 2026-11-01] New' };
  const removal = { proposals: [{ target_slug: 'core', proposed_text: '## Current focus\n- [last mentioned 2026-11-01] New', sources: [] }] };
  assert.equal(cleanProposals(removal, [], pages, [], true).proposals.length, 1);
  assert.equal(cleanProposals(removal, [], pages, [], false).proposals.length, 0);

  const invented = { proposals: [{ target_slug: 'core', proposed_text: '## Current focus\n- Something made up', sources: [] }] };
  assert.equal(cleanProposals(invented, [], pages, [], true).proposals.length, 0);
  assert.equal(onlyRemovesLines(pages.core, invented.proposals[0].proposed_text), false);
});

test('the condenser prompt carries the date and the stale lines', () => {
  const p = buildCondenserPrompt({ pages: {}, skipSlugs: [], weekNotes: '', today: '2026-11-05', staleLines: ['- [last mentioned 2026-10-01] Old'] });
  assert.match(p, /Today is 2026-11-05/);
  assert.match(p, /STALE[\s\S]*Old/);
});

function fakeDb(results = {}) {
  const inserts = [];
  const chain = (table) => {
    const q = {
      insert(rows) { inserts.push({ table, rows }); return Object.assign(Promise.resolve({ error: results.noteError ?? null }), q); },
      select() { return q; }, eq() { return q; }, order() { return q; },
      limit(n) { q.limited = n; return Promise.resolve({ data: results[table] ?? [], error: null, limited: n }); },
      single() { return Promise.resolve({ data: { id: 'log-1', created_at: 'now' }, error: null }); },
    };
    return q;
  };
  return { from: chain, inserts };
}

test('addSessionLog saves notes tied to the log, and a note failure keeps the log', async () => {
  const db1 = fakeDb();
  const r = await addSessionLog(db1, ME, { title: 't', summary: 's', project: 'p', about_me: ['Likes testing ideas', 'None', ''] });
  assert.equal(r.about_saved, 1);
  const noteInsert = db1.inserts.find((i) => i.table === 'about_me_notes');
  assert.deepEqual(noteInsert.rows, [{ user_id: ME, note: 'Likes testing ideas', project: 'p', session_log_id: 'log-1' }]);

  const db2 = fakeDb({ noteError: { message: 'boom' } });
  const realError = console.error; console.error = () => {};
  try {
    const r2 = await addSessionLog(db2, ME, { title: 't', summary: 's', about_me: ['x'] });
    assert.equal(r2.saved, true);
    assert.equal(r2.about_saved, 0);
  } finally { console.error = realError; }
});

test('cleanAboutNotes keeps at most 3 and leaves out oversized notes', () => {
  assert.deepEqual(cleanAboutNotes(['a', 'b', 'c', 'd']), ['a', 'b', 'c']);
  assert.deepEqual(cleanAboutNotes(['x'.repeat(301), 'ok']), ['ok']);
  assert.deepEqual(cleanAboutNotes('not a list'), []);
});

test('recentSessions returns logs and notes, labeled as data', async () => {
  const r = await recentSessions(fakeDb({ session_logs: [{ title: 'a' }], about_me_notes: [{ note: 'b' }] }), ME, { limit: 999 });
  assert.equal(r.sessions[0].title, 'a');
  assert.equal(r.about_me_notes[0].note, 'b');
  assert.match(r.note, /not instructions/);
});

test('the worker reads the About Brandan section, wherever it falls', () => {
  const raw = 'TITLE: A session\n## Decisions\n- None\n## About Brandan\n- Wants to test ideas himself\n- None\n## Next steps\n- Ship';
  assert.deepEqual(parseAboutMe(raw), ['Wants to test ideas himself']);
  assert.deepEqual(parseAboutMe('## About Brandan\n- None'), []);
  assert.deepEqual(parseAboutMe('## Decisions\n- x'), []);
  const parsed = parseSummary('TITLE: T\n## Decisions\n- x\n## About Brandan\n- Last section works');
  assert.deepEqual(parsed.aboutMe, ['Last section works']);
  assert.equal(parsed.title, 'T');
});

test('one-prompt sessions count when they did real work; a quick question does not', () => {
  const msg = (role, chars) => ({ role, text: 'x'.repeat(chars) });
  assert.equal(w.isTooShort([msg('user', 50), msg('assistant', 200)]), true, 'nearly empty');
  assert.equal(w.isTooShort([msg('user', 200), msg('assistant', 2000)]), true, 'one quick question');
  assert.equal(w.isTooShort([msg('user', 100), msg('assistant', 500), msg('assistant', 500), msg('assistant', 500), msg('assistant', 500)]), false, 'pasted prompt that ran a build');
  assert.equal(w.isTooShort([msg('user', 6000), msg('assistant', 300)]), false, 'long pasted prompt');
  assert.equal(w.isTooShort([msg('user', 800), msg('assistant', 300), msg('user', 300), msg('assistant', 300), msg('user', 300)]), false, 'three messages');
});

test('long messages from the owner keep far more text than Claude replies do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-transcript-'));
  try {
    const file = join(dir, 't.jsonl');
    const line = (type, text) => JSON.stringify({ type, message: { role: type, content: text } });
    writeFileSync(file, [line('user', 'p'.repeat(14000)), line('assistant', 'c'.repeat(14000))].join('\n'));
    const [user, claude] = w.readTranscript(file);
    assert.equal(user.text.length, 14000);
    assert.ok(claude.text.length < 1600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the summary prompt keeps new projects from being called one-offs', () => {
  assert.match(w.PROMPT_HEAD, /anything about a new or existing project, is never a one-off/);
  assert.match(w.PROMPT_HEAD, /started or described a new project or a big plan/);
});

test('gap notes reach old notes, skip brand new ones and class work', () => {
  const thoughts = [
    { content: 'Old thought about faith', created_at: '2026-09-01T00:00:00Z' },
    { content: 'Saved just now', created_at: '2026-11-05T00:00:00Z' },
    { content: 'MEGA simulation pricing', created_at: '2026-10-01T00:00:00Z' },
    { content: 'BUS-485 reading', created_at: '2026-10-01T00:00:00Z' },
    { content: 'Mid thought', summary: 'A summary', created_at: '2026-10-10T00:00:00Z' },
  ];
  const { count, notes } = pickGapNotes(thoughts, NOW);
  assert.equal(count, 2);
  assert.match(notes, /2026-09-01/);
  assert.match(notes, /Mid thought/);
  assert.doesNotMatch(notes, /Saved just now|MEGA|BUS-485/);
  assert.ok(notes.indexOf('2026-09-01') < notes.indexOf('2026-10-10'), 'oldest first');
});

test('a note keeps its ending, and a cut note says so and carries its summary', () => {
  const turn = 'x'.repeat(700) + ' but this goal might not be the best one';
  const whole = pickGapNotes([1, 2, 3, 4, 5].map(() => ({ content: turn, summary: 'S', created_at: '2026-10-01T00:00:00Z' })), NOW).notes;
  assert.match(whole, /might not be the best one/);
  assert.doesNotMatch(whole, /cut off/);

  const cut = pickGapNotes([{ content: 'y'.repeat(3000), summary: 'The whole point', created_at: '2026-10-01T00:00:00Z' }], NOW).notes;
  assert.match(cut, /Summary of the whole note: The whole point/);
  assert.match(cut, /\[cut off\]$/);
});

test('the gap prompt judges a note by where it ends up', () => {
  assert.match(GAP_SYSTEM_PROMPT, /Their position is where the note ends up/);
});

test('gap notes change between runs when there are too many to fit', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    content: `Note ${i} ` + 'x'.repeat(380), created_at: '2026-01-01T00:00:00Z',
  }));
  let seed = 1;
  const a = pickGapNotes(many, NOW, () => (seed = (seed * 16807) % 2147483647) / 2147483647).notes;
  seed = 7;
  const b = pickGapNotes(many, NOW, () => (seed = (seed * 16807) % 2147483647) / 2147483647).notes;
  assert.notEqual(a, b);
});

test('the gap prompt rules out "did you finish" questions', () => {
  assert.match(GAP_SYSTEM_PROMPT, /Never ask whether they finished/);
});
