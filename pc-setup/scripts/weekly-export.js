#!/usr/bin/env node
// Weekly export of Open Brain to your PC.
//
//   node weekly-export.js            normal run (exits at once if this week's export exists)
//   node weekly-export.js --force    export again even if this week is done
//   node weekly-export.js --check    test the connection: fetch one page, print counts, write nothing
//   node weekly-export.js --dir D:\somewhere   use another folder (same safety checks)
//
// Writes to %USERPROFILE%\open-brain-export (or EXPORT_DIR in %USERPROFILE%\.open-brain\.env):
//   thoughts\<id>-<short-title>.md   one per non-archived thought, YAML front matter for Obsidian
//   library\<id>-<short-title>.md    one per library entry
//   backups\open-brain-backup-YYYY-MM-DD.json   everything needed to restore, incl. archived
//                                                thoughts, thought_links and library_links; no embeddings
//   export-log.txt                   what each run did
//   .last-export.json                which week was last completed
//
// Never deletes a file. Items that disappeared from the brain are reported, and their files kept.
// Exit code 0 = done (or already done this week). 1 = failed; the repeating Task Scheduler
// trigger simply tries again later.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getConfig } = require("./lib/config");
const { callExport } = require("./lib/brain-api");

const PAGE_LIMIT = 25;

// ---------- safety: never export private text into a synced or versioned folder ----------

function norm(p) {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function isInside(child, parent) {
  const c = norm(child), p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Follow junctions/symlinks for the part of the path that exists already.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

function folderProblem(dir, env = process.env) {
  const candidates = [path.resolve(dir), realish(dir)];
  for (const d of candidates) {
    for (const v of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      if (env[v] && isInside(d, env[v])) return `it is inside OneDrive (${env[v]})`;
    }
    const parts = d.split(/[\\/]+/);
    const synced = parts.find((s) => /^onedrive\b/i.test(s) || /^(dropbox|google drive|icloud ?drive)$/i.test(s));
    if (synced) return `it is inside a synced folder ("${synced}")`;
    let cur = d;
    for (;;) {
      if (fs.existsSync(path.join(cur, ".git"))) return `it is inside a git repository (${cur})`;
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  if (norm(path.resolve(dir)) === norm(os.homedir())) return "it is your whole home folder; use a subfolder";
  return null;
}

// ---------- weeks ----------

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---------- files ----------

function slug(text, max = 40) {
  return String(text || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const SAFE_ID = /^[0-9a-f-]{36}$/i;

function fileNameFor(id, title) {
  if (!SAFE_ID.test(String(id))) throw new Error(`Unexpected id format: ${String(id).slice(0, 50)}`);
  const s = slug(title);
  return s ? `${id}-${s}.md` : `${id}.md`;
}

// id -> existing file name, so a file keeps its name even if the title changes later.
function existingFiles(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    const m = /^([0-9a-f-]{36})(?:-.*)?\.md$/i.exec(f);
    if (m) map.set(m[1].toLowerCase(), f);
  }
  return map;
}

function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, "utf8") === text) return false;
  } catch { /* new file */ }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  return true;
}

// YAML that Obsidian reads. Every string is double-quoted (JSON strings are valid YAML).
function yamlValue(v) {
  if (v === null || v === undefined) return '""';
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

function frontMatter(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    lines.push(`${k}: ${yamlValue(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function firstLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

const asTags = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);

function thoughtMarkdown(t) {
  const m = t.metadata && typeof t.metadata === "object" ? t.metadata : {};
  return frontMatter({
    id: t.id,
    type: "thought",
    created: t.created_at,
    category: typeof m.category === "string" ? m.category : typeof m.type === "string" ? m.type : undefined,
    tags: asTags(m.tags),
    summary: typeof m.summary === "string" ? m.summary : undefined,
    source: "open-brain",
  }) + String(t.content ?? "") + "\n";
}

function libraryMarkdown(e) {
  return frontMatter({
    id: e.id,
    type: "library",
    title: e.title,
    doc_type: e.doc_type,
    course: e.course,
    topic: e.topic,
    tags: asTags(e.tags),
    source_url: e.source_url,
    summary: e.summary,
    created: e.created_at,
    source: "open-brain",
  }) + `# ${String(e.title || "Untitled").replace(/\s+/g, " ")}\n\n` + String(e.content ?? "") + "\n";
}

// ---------- download ----------

async function fetchAll(table, extra, log, opts = {}) {
  const rows = [];
  let after = null;
  for (let page = 1; ; page++) {
    const res = await callExport({ table, after, limit: PAGE_LIMIT, ...extra }, opts);
    if (!res || !Array.isArray(res.rows)) throw new Error(`export-brain gave an unexpected reply for ${table}`);
    rows.push(...res.rows);
    if (opts.onePage || res.done) break;
    if (!res.next_after || res.next_after === after) throw new Error(`export-brain paging stalled on ${table}`);
    after = res.next_after;
    if (page % 20 === 0) log(`  ${table}: ${rows.length} so far...`);
    if (page > 100000) throw new Error("too many pages");
  }
  return rows;
}

// ---------- main ----------

async function run(argv = process.argv.slice(2)) {
  const args = { force: argv.includes("--force"), check: argv.includes("--check") };
  const dirIdx = argv.indexOf("--dir");
  const cfg = getConfig();
  const outDir = path.resolve(dirIdx >= 0 && argv[dirIdx + 1] ? argv[dirIdx + 1] : cfg.exportDir);
  const say = (s) => console.log(s);

  if (!cfg.ready) {
    say(`Settings missing. Put OPEN_BRAIN_FUNCTIONS_URL and MCP_ACCESS_KEY in ${cfg.envFile}`);
    return 1;
  }

  if (args.check) {
    for (const table of ["thoughts", "library", "thought_links", "library_links"]) {
      const rows = await fetchAll(table, {}, say, { onePage: true });
      say(`OK ${table}: first page has ${rows.length} rows`);
    }
    say("Connection works. Nothing was written.");
    return 0;
  }

  const problem = folderProblem(outDir);
  if (problem) {
    say(`Refusing to export to ${outDir}: ${problem}.`);
    say("This is private text. Pick a plain local folder (set EXPORT_DIR in your .env).");
    return 1;
  }

  const week = isoWeek();
  const stateFile = path.join(outDir, ".last-export.json");
  if (!args.force) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (state.week === week && state.backup && fs.existsSync(path.join(outDir, "backups", state.backup))) {
        say(`This week's export (${week}) already exists. Nothing to do. Use --force to export again.`);
        return 0;
      }
    } catch { /* no state yet */ }
  }

  for (const sub of ["thoughts", "library", "backups"]) fs.mkdirSync(path.join(outDir, sub), { recursive: true });
  const logFile = path.join(outDir, "export-log.txt");
  const lines = [];
  const log = (s) => { say(s); lines.push(s); };
  log(`=== ${new Date().toISOString()} export ${week} ===`);

  // 1. Download everything first. If anything fails, nothing is half-written.
  const allThoughts = await fetchAll("thoughts", { include_archived: true }, log);
  const library = await fetchAll("library", {}, log);
  const links = await fetchAll("thought_links", {}, log);
  // Takeaway -> source links. A backfill can't rebuild these, so they belong in the backup.
  // An export-brain deployed before library_links existed answers "table must be one of":
  // then the backup still runs, without them, and the log says so.
  let libraryLinks = null;
  try {
    libraryLinks = await fetchAll("library_links", {}, log);
  } catch (err) {
    if (!/table must be one of/.test(String(err && err.message))) throw err;
    log("WARNING: library_links were NOT backed up: export-brain is an older version. Redeploy export-brain.");
  }
  const thoughts = allThoughts.filter((t) => !t.archived_at);
  log(`Downloaded ${allThoughts.length} thoughts (${allThoughts.length - thoughts.length} archived), ` +
      `${library.length} library entries, ${links.length} links` +
      (libraryLinks ? `, ${libraryLinks.length} library links.` : ", no library links."));

  // 2. Backup JSON (never overwrites an earlier backup).
  let backupName = `open-brain-backup-${localDate()}.json`;
  if (fs.existsSync(path.join(outDir, "backups", backupName))) {
    const d = new Date();
    backupName = `open-brain-backup-${localDate()}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}.json`;
  }
  const backup = {
    format: "open-brain-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    note: "Embeddings are not included; the backfill-embeddings / backfill-chunks / backfill-links jobs rebuild them. user_id is not included; restore with your OWNER_USER_ID.",
    counts: { thoughts: allThoughts.length, archived_thoughts: allThoughts.length - thoughts.length, library: library.length, thought_links: links.length,
      library_links: libraryLinks ? libraryLinks.length : null },
    thoughts: allThoughts,
    library,
    thought_links: links,
    library_links: libraryLinks, // null = not included (older export-brain)
  };
  const backupPath = path.join(outDir, "backups", backupName);
  fs.writeFileSync(`${backupPath}.tmp-${process.pid}`, JSON.stringify(backup, null, 1), "utf8");
  fs.renameSync(`${backupPath}.tmp-${process.pid}`, backupPath);
  log(`Backup: backups\\${backupName}`);

  // 3. Markdown files.
  const writeSet = (sub, items, render, titleOf) => {
    const dir = path.join(outDir, sub);
    const existing = existingFiles(dir);
    let added = 0, updated = 0, same = 0;
    const seen = new Set();
    for (const item of items) {
      const id = String(item.id).toLowerCase();
      seen.add(id);
      const name = existing.get(id) || fileNameFor(id, titleOf(item));
      const isNew = !existing.has(id);
      const changed = writeIfChanged(path.join(dir, name), render(item));
      if (isNew) added++; else if (changed) updated++; else same++;
    }
    const gone = [...existing.entries()].filter(([id]) => !seen.has(id)).map(([, f]) => f);
    log(`${sub}: ${added} new, ${updated} updated, ${same} unchanged.`);
    if (gone.length) {
      log(`${sub}: ${gone.length} file(s) are no longer in the brain (archived or removed). Kept, not deleted:`);
      for (const f of gone) log(`  ${sub}\\${f}`);
    }
  };
  writeSet("thoughts", thoughts, thoughtMarkdown, (t) => firstLine(t.content));
  writeSet("library", library, libraryMarkdown, (e) => e.title || firstLine(e.content));

  // 4. Mark the week done last, so a failed run is retried by the next trigger.
  fs.writeFileSync(stateFile, JSON.stringify({ week, backup: backupName, finished_at: new Date().toISOString() }, null, 2));
  log("Done.");
  fs.appendFileSync(logFile, lines.join(os.EOL) + os.EOL, "utf8");
  return 0;
}

if (require.main === module) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Export failed: ${err && err.message ? err.message : err}`);
      process.exit(1);
    },
  );
}

module.exports = { run, folderProblem, isoWeek, slug, fileNameFor, frontMatter, thoughtMarkdown, libraryMarkdown };
