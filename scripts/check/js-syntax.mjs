// Step 1: does every JavaScript file (and every <script> inside the .html pages) parse?
// Also checks that .json files outside supabase/functions are valid JSON.
// This only catches typos like a missing bracket. It does not run the code.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { ROOT, walk, rel, run, pool } from './lib.mjs';

const JS = new Set(['.js', '.mjs', '.cjs']);

// Browser pages load the root .js files as classic scripts, so try that first (exactly what the
// browser does). If that fails, ask Node, which also understands import/export and require().
async function checkFile(file) {
  const src = readFileSync(file, 'utf8');
  if (extname(file) === '.js') {
    try { new vm.Script(src, { filename: rel(file) }); return null; } catch { /* try Node next */ }
  }
  const r = await run(process.execPath, ['--check', file], { timeoutMs: 30_000 });
  return r.code === 0 ? null : `${rel(file)}\n${r.out.trim()}`;
}

// <script> blocks written straight into an .html file (no src=).
async function checkInlineScripts(file, tmp) {
  const html = readFileSync(file, 'utf8');
  const problems = [];
  let count = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = m[1];
    const code = m[2];
    if (/\bsrc\s*=/i.test(attrs) || !code.trim()) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1]?.toLowerCase() || '';
    const line = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length; // line where the code starts
    if (type === 'application/json' || type === 'application/ld+json' || type === 'importmap') {
      count++;
      try { JSON.parse(code); } catch (e) { problems.push(`${rel(file)}, <script> at line ${line}: ${e.message}`); }
      continue;
    }
    if (type && type !== 'module' && !/javascript|ecmascript/.test(type)) continue; // templates etc.
    count++;
    if (type === 'module') {
      const tmpFile = join(tmp, `inline-${count}.mjs`);
      writeFileSync(tmpFile, '\n'.repeat(line - 1) + code);
      const r = await run(process.execPath, ['--check', tmpFile], { timeoutMs: 30_000 });
      if (r.code !== 0) problems.push(`${rel(file)}, <script type="module"> starting at line ${line}:\n${r.out.trim()}`);
    } else {
      try {
        new vm.Script(code, { filename: rel(file), lineOffset: line - 1 });
      } catch (e) {
        const where = (e.stack || '').split('\n')[0];
        problems.push(`${rel(file)}, <script> starting at line ${line}: ${e.message}\n  at ${where}`);
      }
    }
  }
  return { count, problems };
}

export async function jsSyntax() {
  const files = walk(ROOT);
  const jsFiles = files.filter((f) => JS.has(extname(f)));
  const htmlFiles = files.filter((f) => extname(f) === '.html');
  // deno.json may legally contain comments, so supabase/functions is left to the Deno step.
  const jsonFiles = files.filter((f) => extname(f) === '.json' && !rel(f).startsWith('supabase/functions/'));
  jsonFiles.push(join(ROOT, '.claude', 'settings.json'));

  const problems = (await pool(jsFiles, 8, checkFile)).filter(Boolean);

  const tmp = mkdtempSync(join(tmpdir(), 'ob-check-'));
  let inline = 0;
  try {
    for (const f of htmlFiles) {
      const r = await checkInlineScripts(f, tmp);
      inline += r.count;
      problems.push(...r.problems);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  let jsonCount = 0;
  for (const f of jsonFiles) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    jsonCount++;
    try { JSON.parse(text); } catch (e) { problems.push(`${rel(f)}: not valid JSON (${e.message})`); }
  }

  const summary = `${jsFiles.length} JS files, ${inline} inline <script> blocks in ${htmlFiles.length} pages, ${jsonCount} JSON files`;
  if (problems.length) return { status: 'fail', summary, details: problems.join('\n\n') };
  return { status: 'ok', summary };
}
