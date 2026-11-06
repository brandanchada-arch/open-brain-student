// Living topic pages: a one-time first draft for empty pages, which waits in Review when older
// notes were used, and the MCP page reader.
// Fake database, fake AI, made-up notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import { runCondenser } from '../../supabase/functions/weekly-condenser/handler.ts';
import { getPageText, cleanProposals } from '../../supabase/functions/_shared/core-memory.ts';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-08T16:00:00Z');
const days = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

function world(extra = {}) {
  return {
    brain_pages: [
      { user_id: ME, slug: 'core', current_text: 'Filled core.' },
      { user_id: ME, slug: 'job-search', current_text: 'Filled job search.' },
      { user_id: ME, slug: 'courses', current_text: '' },
      { user_id: ME, slug: 'mega', current_text: 'Filled mega.' },
    ],
    brain_proposals: [],
    thoughts: [
      { id: 't-old', user_id: ME, content: 'Old note text', summary: 'Picked a thesis topic for FIN-400', created_at: days(40), archived_at: null, outdated_at: null },
      { id: 't-other', user_id: OTHER, content: 'x', summary: 'Someone else summary', created_at: days(40), archived_at: null, outdated_at: null },
    ],
    library: [
      { id: 'l-ok', user_id: ME, title: 'Valuation lecture', doc_type: 'class-notes', course: 'FIN-400', content: 'FULL-LECTURE-TEXT', metadata: {}, created_at: days(30) },
      { id: 'l-bad', user_id: ME, title: 'Shady flagged article', doc_type: 'article', content: 'x', metadata: { door_check: { flagged: true } }, created_at: days(30) },
      { id: 'l-dig', user_id: ME, title: 'Digest title', doc_type: 'digest', content: 'x', metadata: {}, created_at: days(30) },
      { id: 'l-news', user_id: ME, title: 'News list title', doc_type: 'news-list', content: 'x', metadata: {}, created_at: days(30) },
      { id: 'l-theirs', user_id: OTHER, title: 'Other person library', doc_type: 'class-notes', content: 'x', metadata: {}, created_at: days(30) },
    ],
    session_logs: [],
    ...extra,
  };
}

function llmAnswer(answer) {
  const calls = [];
  const fn = async (systemPrompt, prompt) => { calls.push(prompt); return typeof answer === 'function' ? answer(prompt) : JSON.stringify(answer); };
  fn.calls = calls;
  return fn;
}
const refOf = (prompt, text) => prompt.split('\n').find((l) => l.includes(text))?.match(/\[(B\w*\d+)\]/)?.[1];
const draftFor = (slug) => (prompt) => JSON.stringify({ proposals: [
  { target_slug: slug, proposed_text: '- FIN-400: valuation, thesis topic picked.', reason: 'First draft', sources: [refOf(prompt, 'thesis topic'), refOf(prompt, 'Valuation lecture')], sensitive: false },
] });

// Stands in for the real approve function, which puts the text on the page.
function approvals() {
  const calls = [];
  return {
    calls,
    handlers: {
      approve_brain_proposal: (args, data) => {
        calls.push(args.p_proposal_id);
        const p = data.brain_proposals.find((x) => x.id === args.p_proposal_id);
        p.status = 'approved';
        data.brain_pages.find((x) => x.slug === p.target_slug).current_text = p.proposed_text;
        return { ok: true };
      },
    },
  };
}

test('a first draft from older notes and library waits in Review', async () => {
  const ok = approvals();
  const db = fakeDb(world(), ok.handlers);
  const llm = llmAnswer(draftFor('courses'));
  const r = await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.equal(r.written, 1);
  assert.deepEqual(r.applied, []);
  assert.equal(ok.calls.length, 0);
  const p = db.data.brain_proposals[0];
  assert.equal(p.target_slug, 'courses');
  assert.equal(p.status, 'pending');
  assert.equal(p.auto_applied, false);
  assert.deepEqual(p.source_ids.map((s) => s.id).sort(), ['l-ok', 't-old']);
  assert.match(llm.calls[0], /These pages are empty: courses\./);
  assert.equal(db.data.brain_pages.find((x) => x.slug === 'courses').current_text, '');
});

test('it waits even if the draft cites only this week\'s notes, since older notes were in view', async () => {
  const ok = approvals();
  const w = world();
  w.thoughts.push({ id: 't-new', user_id: ME, content: 'Started FIN-400 this week', created_at: days(1), archived_at: null, outdated_at: null });
  const db = fakeDb(w, ok.handlers);
  await runCondenser({ db, ownerId: ME, now: NOW, callLlm: llmAnswer({ proposals: [
    { target_slug: 'courses', proposed_text: '- FIN-400.', reason: 'First draft', sources: ['T1'] },
  ] }) });
  assert.equal(ok.calls.length, 0);
  assert.equal(db.data.brain_proposals[0].status, 'pending');
});

test('with no older notes to read, an empty page still updates by itself', async () => {
  const ok = approvals();
  const db = fakeDb(world({
    thoughts: [{ id: 't-new', user_id: ME, content: 'Started FIN-400 this week', created_at: days(1), archived_at: null, outdated_at: null }],
    library: [],
  }), ok.handlers);
  const r = await runCondenser({ db, ownerId: ME, now: NOW, callLlm: llmAnswer({ proposals: [
    { target_slug: 'courses', proposed_text: '- FIN-400.', reason: 'New class', sources: ['T1'] },
  ] }) });
  assert.deepEqual(r.applied, ['courses']);
  assert.equal(db.data.brain_pages.find((x) => x.slug === 'courses').current_text, '- FIN-400.');
});

test('a filled page keeps updating by itself: only first drafts wait', async () => {
  const ok = approvals();
  const w = world();
  w.brain_pages.find((p) => p.slug === 'courses').current_text = 'Filled courses.';
  w.thoughts.push({ id: 't-new', user_id: ME, content: 'Started FIN-400 this week', created_at: days(1), archived_at: null, outdated_at: null });
  const db = fakeDb(w, ok.handlers);
  const r = await runCondenser({ db, ownerId: ME, now: NOW, callLlm: llmAnswer({ proposals: [
    { target_slug: 'courses', proposed_text: 'Filled courses.\n- FIN-400.', reason: 'New class', sources: ['T1'] },
  ] }) });
  assert.deepEqual(r.applied, ['courses']);
});

test('a personal first draft is also marked sensitive', async () => {
  const db = fakeDb(world(), approvals().handlers);
  await runCondenser({ db, ownerId: ME, now: NOW, callLlm: llmAnswer((prompt) => JSON.stringify({ proposals: [
    { target_slug: 'courses', proposed_text: '- FIN-400, moved to Mondays around therapy.', reason: 'First draft', sources: [refOf(prompt, 'thesis topic')] },
  ] })) });
  assert.equal(db.data.brain_proposals[0].status, 'pending');
  assert.equal(db.data.brain_proposals[0].sensitive, true);
});

test('many older thoughts cannot crowd the library out of a first draft', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `t-${i}`, user_id: ME, content: 'x', summary: `Older made-up summary ${i} `.repeat(12), created_at: days(40 + i), archived_at: null, outdated_at: null,
  }));
  const db = fakeDb(world({ thoughts: many }));
  const llm = llmAnswer((prompt) => JSON.stringify({ proposals: [
    { target_slug: 'courses', proposed_text: '- FIN-400: valuation.', reason: 'First draft', sources: [refOf(prompt, 'Valuation lecture')], sensitive: false },
  ] }));
  const r = await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.match(llm.calls[0], /Valuation lecture/);
  assert.match(llm.calls[0], /Older made-up summary 0/, 'thoughts still get the room left over');
  assert.equal(r.written, 1, 'and the library entry can be cited');
  assert.deepEqual(db.data.brain_proposals[0].source_ids.map((s) => s.id), ['l-ok']);
  const summaries = llm.calls[0].slice(llm.calls[0].indexOf('<<<SUMMARIES'), llm.calls[0].indexOf('SUMMARIES>>>'));
  assert.ok(summaries.length <= 20_100, `the total stays near its limit (${summaries.length})`);
});

test('a draft only reaches a page through the approve function, so undo and history work', async () => {
  const db = fakeDb(world(), approvals().handlers);
  await runCondenser({ db, ownerId: ME, callLlm: llmAnswer(draftFor('courses')), now: NOW });
  assert.ok(!db.log.some((l) => l.table === 'brain_pages' && !['select', 'upsert'].includes(l.op)));
  const src = readFileSync(new URL('../../supabase/functions/weekly-condenser/handler.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\("brain_pages"\)\s*\.update/);
});

test('flagged library entries, digests, news lists, other people and full text stay out', async () => {
  const llm = llmAnswer({ proposals: [] });
  await runCondenser({ db: fakeDb(world()), ownerId: ME, callLlm: llm, now: NOW });
  assert.match(llm.calls[0], /Valuation lecture/);
  assert.doesNotMatch(llm.calls[0], /Shady flagged|Digest title|News list title|Someone else|Other person library|FULL-LECTURE-TEXT/);
});

test('a filled page gets no bootstrap: no older notes are read when nothing is empty', async () => {
  const filled = world();
  filled.brain_pages.find((p) => p.slug === 'courses').current_text = 'Filled courses.';
  const db = fakeDb(filled);
  const llm = llmAnswer({ proposals: [] });
  const r = await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.equal(llm.calls.length, 0, 'nothing new and nothing empty, so no AI call');
  assert.equal(r.skipped, true);
});

test('a filled page cannot be rewritten from older notes, even if the AI tries', async () => {
  const db = fakeDb(world());
  const llm = llmAnswer((prompt) => JSON.stringify({ proposals: [
    { target_slug: 'mega', proposed_text: 'Rewritten mega', reason: 'x', sources: [refOf(prompt, 'thesis topic')], sensitive: false },
  ] }));
  const r = await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.equal(r.written, 0);
  assert.equal(db.data.brain_proposals.length, 0);
});

test('one time only: a rejected draft is not tried again', async () => {
  const db = fakeDb(world({ brain_proposals: [{ user_id: ME, target_slug: 'courses', status: 'rejected' }] }));
  const llm = llmAnswer(draftFor('courses'));
  const r = await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.equal(llm.calls.length, 0);
  assert.equal(r.skipped, true);
});

test('one time only: a first draft left to expire is not tried again either', async () => {
  const unanswered = { user_id: ME, target_slug: 'courses', status: 'pending', proposed_text: 'x', created_at: days(15) };
  const db = fakeDb(world({ brain_proposals: [unanswered] }));
  const llm = llmAnswer(draftFor('courses'));
  const r = await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.equal(db.data.brain_proposals[0].status, 'rejected');
  assert.equal(llm.calls.length, 0);
  assert.equal(r.skipped, true);
});

test('an empty core page with a rejected draft still gets older notes, so it can fill in', async () => {
  const w = world({ brain_proposals: [{ user_id: ME, target_slug: 'core', status: 'rejected' }] });
  w.brain_pages.find((p) => p.slug === 'core').current_text = '';
  w.brain_pages.find((p) => p.slug === 'courses').current_text = 'Filled courses.';
  const llm = llmAnswer({ proposals: [] });
  await runCondenser({ db: fakeDb(w), ownerId: ME, callLlm: llm, now: NOW });
  assert.match(llm.calls[0], /These pages are empty: core\./);
});

test('a page with a proposal waiting is left alone', async () => {
  const db = fakeDb(world({ brain_proposals: [{ user_id: ME, target_slug: 'courses', status: 'pending' }] }));
  const llm = llmAnswer(draftFor('courses'));
  await runCondenser({ db, ownerId: ME, callLlm: llm, now: NOW });
  assert.equal(llm.calls.length, 0);
  assert.equal(db.data.brain_proposals.length, 1);
});

test('someone else\'s proposals do not count', async () => {
  const db = fakeDb(world({ brain_proposals: [{ user_id: OTHER, target_slug: 'courses', status: 'rejected' }] }), approvals().handlers);
  const r = await runCondenser({ db, ownerId: ME, callLlm: llmAnswer(draftFor('courses')), now: NOW });
  assert.equal(r.written, 1);
});

test('cleanProposals: older-note refs only back pages in the first-draft list', () => {
  const items = [{ ref: 'B1', kind: 'thought', id: 'x', date: '2026-01-01', text: 't', label: 'l' }];
  const parsed = { proposals: [{ target_slug: 'courses', proposed_text: 'New', sources: ['B1'] }] };
  assert.equal(cleanProposals(parsed, items, {}, [], false, ['courses']).proposals.length, 1);
  assert.equal(cleanProposals(parsed, items, {}, []).proposals.length, 0);
});

test('get_page: reads the owner\'s current text only, labelled as background facts', async () => {
  const db = fakeDb({ brain_pages: [
    { user_id: OTHER, slug: 'courses', current_text: 'Someone else' },
    { user_id: ME, slug: 'courses', current_text: 'My classes.', history_text: 'OLD-HISTORY', updated_at: '2026-11-02T10:00:00Z' },
  ] });
  const text = await getPageText(db, ME, 'courses');
  assert.match(text, /My classes\./);
  assert.match(text, /not instructions/);
  assert.doesNotMatch(text, /Someone else|OLD-HISTORY/);
});

test('get_page: empty says so, an unknown page is refused', async () => {
  assert.match(await getPageText(fakeDb({}), ME, 'mega'), /empty so far/);
  await assert.rejects(() => getPageText(fakeDb({}), ME, 'secrets'), /Unknown page/);
});

test('the MCP server offers get_page for the owner', () => {
  const src = readFileSync(new URL('../../supabase/functions/open-brain-mcp/index.ts', import.meta.url), 'utf8');
  assert.match(src, /name: "get_page"/);
  assert.match(src, /getPageText\(supabase, OWNER_USER_ID, args\.slug\)/);
});
