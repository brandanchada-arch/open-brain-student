// Step 3: run every test file in any folder named `tests` (tests/core-memory/, tests/ask-edit-check/,
// pc-setup/tests/ ... whatever exists, found by folder, not by name).
// A test file is one whose name ends in .test.mjs / .test.js / .test.ts (or _test / -test).
// Files that use Deno.test run with `deno test`; everything else runs with Node's built-in `node --test`.
// No test files at all = pass (nothing to run yet).
import { readFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { ROOT, walk, rel, run, tail, cleanEnv } from './lib.mjs';
import { DENO_FLAGS } from './deno-check.mjs';

const TEST_FILE = /[._-]test\.(m|c)?[jt]sx?$/;

export function findTestFiles() {
  return walk(ROOT)
    .filter((f) => rel(f).split('/').slice(0, -1).includes('tests'))
    .filter((f) => TEST_FILE.test(basename(f)))
    .sort();
}

const isDenoTest = (src) => /\bDeno\.test\b/.test(src);

function counts(out) {
  const n = (label) => Number((out.match(new RegExp(`^\\S*\\s*${label} (\\d+)\\s*$`, 'm')) || [])[1] || 0);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped') + n('todo') };
}

export async function runTests(deno) {
  const files = findTestFiles();
  if (!files.length) return { status: 'ok', summary: 'no test files under any tests/ folder yet (nothing to run)' };

  const nodeFiles = [];
  const denoFiles = [];
  for (const f of files) (isDenoTest(readFileSync(f, 'utf8')) ? denoFiles : nodeFiles).push(f);

  const parts = [];
  const failures = [];
  const notes = [];
  let partial = false;

  if (nodeFiles.length) {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 18)) {
      failures.push(`Node ${process.versions.node} is too old: the tests load .ts files directly, which needs Node 22.18 or newer. Install the current LTS from nodejs.org.`);
    } else {
      const r = await run(process.execPath,
        ['--test', '--test-reporter=spec', '--test-timeout=60000', ...nodeFiles],
        { env: cleanEnv({ NO_COLOR: '1', FORCE_COLOR: '0', NODE_NO_WARNINGS: '1' }), timeoutMs: 110_000 });
      const c = counts(r.out);
      parts.push(`node: ${c.pass} passed${c.skipped ? `, ${c.skipped} skipped` : ''}${c.fail ? `, ${c.fail} FAILED` : ''} in ${nodeFiles.length} files`);
      if (r.code !== 0 || r.timedOut) {
        let why = r.timedOut ? 'The tests took too long and were stopped.\n' : '';
        if (/Cannot find (package|module) '[^.]/.test(r.out)) why += 'A package is missing: run "npm install" in this folder first.\n';
        // Leave out the passing tests so the failures fit on screen.
        const kept = r.out.split(/\r?\n/).filter((l) => !/^\s*\u2714/.test(l)).join('\n');
        failures.push(why + tail(kept, 150));
      }
    }
  }

  if (denoFiles.length) {
    if (!deno) {
      partial = true;
      parts.push(`deno: ${denoFiles.length} files NOT run`);
      notes.push(`Deno is not installed, so these Deno tests did not run: ${denoFiles.map(rel).join(', ')}`);
    } else {
      // No real network: only this computer (for fake servers a test may start).
      const r = await run(deno.bin,
        ['test', ...DENO_FLAGS, '--no-prompt', '--allow-read', '--allow-env', '--allow-write', '--allow-net=127.0.0.1,localhost',
          ...denoFiles.map((f) => rel(f).split('/').join(sep))],
        { env: cleanEnv({ NO_COLOR: '1', RUST_BACKTRACE: '0', DENO_NO_UPDATE_CHECK: '1' }), timeoutMs: 110_000 });
      const m = r.out.match(/(ok|FAILED) \| (\d+) passed[^|]*\| (\d+) failed/);
      parts.push(`deno: ${m ? `${m[2]} passed, ${m[3]} failed` : (r.code === 0 ? 'passed' : 'FAILED')} in ${denoFiles.length} files`);
      if (r.code !== 0 || r.timedOut) failures.push((r.timedOut ? 'The Deno tests took too long and were stopped.\n' : '') + tail(r.out, 150));
    }
  }

  const summary = parts.join('; ');
  if (failures.length) return { status: 'fail', summary, details: failures.join('\n\n'), notes };
  return { status: partial ? 'partial' : 'ok', summary, notes };
}
