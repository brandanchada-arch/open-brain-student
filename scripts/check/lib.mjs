// Small helpers shared by the check steps. Works the same on Windows and Linux.
import { readdirSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Folders never searched: installed packages, git's own data, and hidden folders (.claude, .vercel ...).
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Every file under `dir` (absolute paths), skipping node_modules, .git and hidden folders. */
export function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Path relative to the repo, always with forward slashes (easier to read on Windows too). */
export const rel = (p) => relative(ROOT, p).split(sep).join('/');

// Environment variables that might hold real keys. Child processes (tests, deno) never see them,
// so a test can't reach a real service by accident.
const SECRET_LIKE = /SUPABASE|OPENROUTER|OPENAI|ANTHROPIC|TELEGRAM|MCP_ACCESS|GOOGLE|API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|BRAIN_OWNER|OWNER_USER/i;
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_LIKE.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/** Run a program (no shell). Resolves { code, out, timedOut }; `out` is stdout+stderr together. */
export function run(cmd, args, { cwd = ROOT, timeoutMs = 90_000, env = cleanEnv() } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: String(err), timedOut, notFound: err.code === 'ENOENT' });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: out + String(err), timedOut, notFound: err.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, timedOut }); });
  });
}

/** Keep failure output readable: the last `max` lines. */
export function tail(text, max = 120) {
  const lines = String(text).replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split(/\r?\n/);
  if (lines.length <= max) return lines.join('\n');
  return `... (${lines.length - max} earlier lines cut)\n` + lines.slice(-max).join('\n');
}

/** Run async jobs with at most `limit` at a time, keeping their order in the result. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
