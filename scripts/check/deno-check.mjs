// Step 2: type-check the edge functions (supabase/functions) with Deno, if Deno is installed.
// One `deno check` per function folder, run from inside that folder so its own deno.json applies.
// Deno downloads imports like npm:@supabase/supabase-js the first time (cached after that).
// If a download fails (no internet, blocked site) that folder is reported as "not checked",
// never as passed.
import { readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { ROOT, walk, rel, run, pool, tail, cleanEnv } from './lib.mjs';

const NETWORK_ERROR = /error sending request|unsuccessful tunnel|dns error|failed to lookup address|connection refused|connection reset|tls handshake|certificate|timed out|Connect\)/i;

/** The deno program to use, or null. Order: DENO_BIN, then `deno` on PATH, then ~/.deno/bin. */
export async function findDeno() {
  const candidates = [];
  if (process.env.DENO_BIN) candidates.push(process.env.DENO_BIN);
  candidates.push('deno');
  candidates.push(join(homedir(), '.deno', 'bin', process.platform === 'win32' ? 'deno.exe' : 'deno'));
  for (const c of candidates) {
    if (c !== 'deno' && !existsSync(c)) continue;
    const r = await run(c, ['--version'], { timeoutMs: 15_000 });
    if (r.code === 0) return { bin: c, version: r.out.split(/\r?\n/)[0].trim() };
  }
  return null;
}

// Deno options used everywhere:
// --node-modules-dir=none : use Deno's own download cache for npm: imports. Without it, Deno sees
//   the repo's package.json and looks in node_modules instead, which is not how functions deploy.
// --no-lock : don't write deno.lock files into the repo (the check must leave files alone).
export const DENO_FLAGS = ['--node-modules-dir=none', '--no-lock', '--quiet'];

export async function denoCheck(deno) {
  if (!deno) return { status: 'skip', summary: 'Deno is not installed, so edge functions were not type-checked' };
  const base = join(ROOT, 'supabase', 'functions');
  let folders = [];
  try {
    folders = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(base, d.name));
  } catch { /* no functions */ }
  const jobs = folders
    .map((dir) => ({ dir, files: walk(dir).filter((f) => ['.ts', '.tsx', '.mts'].includes(extname(f))) }))
    .filter((j) => j.files.length);

  const env = cleanEnv({ NO_COLOR: '1', RUST_BACKTRACE: '0', DENO_NO_UPDATE_CHECK: '1' });
  const results = await pool(jobs, 4, async ({ dir, files }) => {
    const args = ['check', ...DENO_FLAGS, ...files.map((f) => f.slice(dir.length + 1))];
    const r = await run(deno.bin, args, { cwd: dir, env, timeoutMs: 100_000 });
    return { dir, ...r };
  });

  const failed = [];
  const notChecked = [];
  for (const r of results) {
    if (r.code === 0) continue;
    if (r.timedOut) notChecked.push(`${rel(r.dir)} (timed out, probably still downloading imports)`);
    else if (NETWORK_ERROR.test(r.out)) notChecked.push(`${rel(r.dir)} (could not download an import: ${(r.out.match(/https?:\/\/[^\s'"]+|npm:[^\s'"]+|jsr:[^\s'"]+/) || ['?'])[0]})`);
    else failed.push(`--- ${rel(r.dir)}\n${tail(r.out, 60)}`);
  }
  const summary = `${jobs.length - failed.length - notChecked.length} of ${jobs.length} function folders type-check (${deno.version})`;
  const notes = notChecked.length ? [`NOT type-checked (download failed, not a code error): ${notChecked.join('; ')}`] : [];
  if (failed.length) return { status: 'fail', summary, details: failed.join('\n\n'), notes };
  return { status: notChecked.length ? 'partial' : 'ok', summary, notes };
}
