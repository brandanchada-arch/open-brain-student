// `npm run check` — Open Brain's offline safety check.
// Needs no keys and touches no real service (no Supabase, no AI, no Telegram).
// Prints one line per step when all is well, the full problem when not.
// Exit code: 0 = passed, 1 = something failed (a hook can stop an agent on that).
//
// Steps: 1 JS syntax · 2 Deno type-check (if Deno is installed) · 3 tests in tests/ folders · 4 SQL in PGlite
// Options: --no-deno   skip Deno even if installed (e.g. offline on a first run)
import { jsSyntax } from './js-syntax.mjs';
import { denoCheck, findDeno } from './deno-check.mjs';
import { runTests } from './run-tests.mjs';
import { sqlSmoke } from './sql-smoke.mjs';

const started = Date.now();
const LIMIT_MS = 150_000;
const guard = setTimeout(() => {
  console.error(`\nCheck FAILED: it took longer than ${LIMIT_MS / 1000}s and was stopped.`);
  process.exit(1);
}, LIMIT_MS);

async function safe(name, fn) {
  try { return { name, ...(await fn()) }; } catch (err) {
    return { name, status: 'fail', summary: 'the check itself crashed', details: err?.stack || String(err) };
  }
}

const deno = process.argv.includes('--no-deno') ? null : await findDeno();

const results = [await safe('JS syntax', jsSyntax)];
results.push(...await Promise.all([
  safe('Deno type-check', () => denoCheck(deno)),
  safe('Tests', () => runTests(deno)),
  safe('SQL smoke test', sqlSmoke),
]));

const MARK = { ok: 'ok  ', skip: 'skip', partial: 'part', fail: 'FAIL' };
for (const r of results) {
  console.log(`${MARK[r.status]}  ${r.name}: ${r.summary}`);
  for (const n of r.notes || []) console.log(`      note: ${n}`);
}
const failed = results.filter((r) => r.status === 'fail');
for (const r of failed) {
  console.error(`\n===== ${r.name} FAILED =====\n${r.details || '(no details)'}`);
}
const secs = Math.round((Date.now() - started) / 1000);
clearTimeout(guard);
if (failed.length) {
  console.error(`\nCheck FAILED (${failed.map((r) => r.name).join(', ')}) in ${secs}s.`);
  process.exit(1);
}
const gaps = results.filter((r) => r.status !== 'ok').length;
console.log(`Check passed in ${secs}s${gaps ? ' (some parts could not run here, see skip/part lines above)' : ''}.`);
