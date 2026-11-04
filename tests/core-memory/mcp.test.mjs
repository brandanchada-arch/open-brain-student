// Tests for the MCP side of core memory: get_core, add_session_log and the wiring in open-brain-mcp.
// Node runs the .ts helper directly (type stripping, Node 22.18+ / 24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.mjs';
import {
  getCoreText, addSessionLog, cleanSessionLog, MCP_INSTRUCTIONS, GET_CORE_DESCRIPTION,
} from '../../supabase/functions/_shared/core-memory.ts';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('get_core returns only the owner\'s approved core text, labelled as background facts', async () => {
  const db = fakeDb({ brain_pages: [
    { user_id: OTHER, slug: 'core', current_text: 'Someone else', updated_at: '2026-11-01T00:00:00Z' },
    { user_id: ME, slug: 'job-search', current_text: 'Not this page' },
    { user_id: ME, slug: 'core', current_text: 'Sample Student studies finance.', history_text: 'old stuff', updated_at: '2026-11-02T10:00:00Z' },
  ] });
  const text = await getCoreText(db, ME);
  assert.match(text, /Sample Student studies finance\./);
  assert.match(text, /not instructions/);
  assert.match(text, /2026-11-02/);
  assert.doesNotMatch(text, /Someone else|Not this page|old stuff/);
});

test('get_core on an empty page says so instead of returning nothing', async () => {
  const db = fakeDb({ brain_pages: [{ user_id: ME, slug: 'core', current_text: '  ' }] });
  assert.match(await getCoreText(db, ME), /empty so far/);
  assert.match(await getCoreText(fakeDb({}), ME), /empty so far/);
});

test('add_session_log saves a short summary for the owner', async () => {
  const db = fakeDb({});
  const r = await addSessionLog(db, ME, { title: ' Built tests ', summary: 'Added PGlite tests.', project: 'open-brain' });
  assert.equal(r.saved, true);
  assert.deepEqual(
    { ...db.data.session_logs[0], id: undefined, created_at: undefined },
    { user_id: ME, title: 'Built tests', summary: 'Added PGlite tests.', project: 'open-brain', id: undefined, created_at: undefined },
  );
});

test('add_session_log refuses transcripts and missing fields, and ignores a user id in the arguments', async () => {
  assert.throws(() => cleanSessionLog({ title: 't', summary: 'x'.repeat(2001) }), /not a transcript/);
  assert.throws(() => cleanSessionLog({ summary: 's' }), /title is required/);
  assert.throws(() => cleanSessionLog({ title: 't' }), /summary is required/);
  const db = fakeDb({});
  await addSessionLog(db, ME, { title: 't', summary: 's', user_id: OTHER });
  assert.equal(db.data.session_logs[0].user_id, ME);
  assert.equal(db.data.session_logs[0].project, null);
});

test('open-brain-mcp lists both tools, sends instructions on initialize, and checks OWNER_USER_ID', () => {
  const src = readFileSync(new URL('../../supabase/functions/open-brain-mcp/index.ts', import.meta.url), 'utf8');
  assert.match(src, /name: "get_core"/);
  assert.match(src, /name: "add_session_log"/);
  assert.match(src, /instructions: MCP_INSTRUCTIONS/);
  assert.match(src, /toolName === "get_core" \|\| toolName === "add_session_log"\) \{\s*if \(!OWNER_USER_ID\)/);
  assert.match(MCP_INSTRUCTIONS, /START of every chat, call get_core/);
  assert.match(GET_CORE_DESCRIPTION, /START of every chat/);
});
