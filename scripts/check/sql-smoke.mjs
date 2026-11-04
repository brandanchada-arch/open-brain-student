// Step 4: load the SQL files into PGlite (a real Postgres that runs inside Node, in memory)
// to catch SQL that would not even run. It is a smoke test: it does not test what the SQL does.
//
// Order:
//   1. sql-stubs/00-supabase-platform.sql  stand-ins for Supabase itself (roles, auth.uid(), pgvector)
//   2. migration.sql                        the course's Level 1 table
//   3. sql-stubs/10-earlier-levels.sql      the Level 2-6 schema that is not in the repo (a best guess)
//   4. supabase/sql/*.sql                   every file, in name (= date) order
//   5. supabase/sql/*.sql again             they say "safe to run more than once", so check that
// A file that fails is reported with the Postgres error and the line it points at, never skipped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, rel } from './lib.mjs';

const STUBS = join(ROOT, 'scripts', 'check', 'sql-stubs');

function lineOf(sql, position) {
  const pos = Number(position);
  return pos > 0 ? sql.slice(0, pos - 1).split('\n').length : null;
}

function describe(err, sql) {
  const line = lineOf(sql, err.position);
  let msg = err.message;
  if (line) msg += ` (line ${line}: ${sql.split('\n')[line - 1].trim().slice(0, 120)})`;
  if (err.where) msg += `\n    where: ${String(err.where).split('\n')[0]}`;
  if (/extension "(pg_cron|pg_net|supabase_vault|pgsodium|http)"|schema "(cron|net|vault|storage|extensions)" does not exist/i.test(err.message)) {
    msg += '\n    (PGlite has no pg_cron / pg_net / Vault / Storage. This file cannot be smoke-tested as written.)';
  }
  return msg;
}

export async function sqlSmoke() {
  let PGlite, vector;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
    ({ vector } = await import('@electric-sql/pglite-pgvector'));
  } catch {
    return { status: 'fail', summary: 'PGlite is not installed', details: 'Run "npm install" in this folder first (it installs PGlite, used only for this check).' };
  }

  const sqlDir = join(ROOT, 'supabase', 'sql');
  let repoFiles = [];
  try { repoFiles = readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(sqlDir, f)); } catch { /* none */ }

  const plan = [
    { file: join(STUBS, '00-supabase-platform.sql'), stub: true },
    { file: join(ROOT, 'migration.sql') },
    { file: join(STUBS, '10-earlier-levels.sql'), stub: true },
    ...repoFiles.map((file) => ({ file })),
    ...repoFiles.map((file) => ({ file, again: true })),
  ];

  const db = await PGlite.create({ extensions: { vector } });
  const problems = [];
  let loaded = 0;
  const failedOnce = new Set();
  try {
    for (const step of plan) {
      let sql;
      try { sql = readFileSync(step.file, 'utf8'); } catch { continue; }
      if (step.again && failedOnce.has(step.file)) continue; // already reported
      try {
        await db.exec(sql);
        if (!step.stub && !step.again) loaded++;
      } catch (err) {
        failedOnce.add(step.file);
        const label = step.stub ? `check stub ${rel(step.file)} (the check's own file)` : rel(step.file);
        problems.push(step.again
          ? `${label} fails when run a SECOND time (it should be safe to re-run): ${describe(err, sql)}`
          : `${label} does not load: ${describe(err, sql)}`);
        if (step.stub) break; // everything after depends on the stubs
      }
    }
  } finally {
    await db.close();
  }

  const summary = `${loaded} of ${repoFiles.length + 1} SQL files load in PGlite${repoFiles.length ? `, ${repoFiles.length} re-run` : ''}`;
  if (problems.length) return { status: 'fail', summary, details: problems.join('\n\n') };
  return { status: 'ok', summary };
}
