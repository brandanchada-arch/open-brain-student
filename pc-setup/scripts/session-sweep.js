#!/usr/bin/env node
// The automatic backup for session summaries. A scheduled task runs this once an hour.
//
// It looks for Claude Code sessions with work no summary covers yet, that have been quiet for
// a long time (24 hours by default), and summarizes a small number per run (1 by default), newest first.
// So old sessions get caught up slowly, and pressing Save summary means there's nothing left to do here.
//
// Nothing is sent to an AI unless a session actually has new work.
// Off switch: SESSION_SWEEP=off in %USERPROFILE%\.open-brain\.env
// Change the pace with SESSION_SWEEP_QUIET_HOURS and SESSION_SWEEP_PER_RUN.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getConfig } = require("./lib/config");
const { summarizeSession, readLedger, saveEntry, upload, readTranscript } = require("./session-log-worker");

const SKIP_FOLDERS = /Temp-nl-drill/; // near-the-loop's throwaway test runs

function listTranscripts(root = path.join(os.homedir(), ".claude", "projects")) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || SKIP_FOLDERS.test(d.name)) continue;
    const dir = path.join(root, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        out.push({ file, sessionId: f.slice(0, -6), size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* it moved */ }
    }
  }
  return out;
}

// The folder the session ran in is on one of the transcript's first lines.
function cwdOf(file) {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 200000).split(/\r?\n/);
    for (const line of head) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } catch { /* unreadable */ }
  return "";
}

// Summaries written before the ledger existed count as done, so nothing gets summarized again.
function adoptOldLogs(cfg, transcripts) {
  let names = [];
  try { names = fs.readdirSync(cfg.sessionLogDir).filter((n) => n.endsWith(".md")).sort(); } catch { return; }
  const ledger = readLedger(cfg);
  const latest = {};
  for (const n of names) {
    const m = /_([0-9a-z]{8})(?:-\d+)?\.md$/.exec(n);
    if (m) latest[m[1]] = n;
  }
  for (const t of transcripts) {
    const name = latest[t.sessionId.slice(0, 8)];
    if (!name || ledger[t.sessionId]) continue;
    const file = path.join(cfg.sessionLogDir, name);
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const title = (/^# (.+)$/m.exec(text) || [])[1] || "Claude Code session";
    const at = text.indexOf("## ");
    saveEntry(cfg, t.sessionId, {
      messages: readTranscript(t.file).length, size: t.size, title,
      summary: at >= 0 ? text.slice(at).trim() : text, file,
    });
  }
}

// Which sessions need work: newest first, quiet long enough, and changed since their summary.
function pickWork(transcripts, ledger, now, quietHours) {
  const quietMs = quietHours * 60 * 60 * 1000;
  return transcripts
    .filter((t) => now - t.mtimeMs >= quietMs)
    .filter((t) => !ledger[t.sessionId] || ledger[t.sessionId].size !== t.size)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function main({ now = Date.now() } = {}) {
  const cfg = getConfig();
  if (!cfg.sessionLogs || !cfg.sessionSweep) return { off: true };
  const transcripts = listTranscripts();
  adoptOldLogs(cfg, transcripts);

  // Uploads that failed before go first, and need no AI call.
  let retried = 0;
  for (const [key, entry] of Object.entries(readLedger(cfg))) {
    if (!entry.pendingUpload) continue;
    if (await upload(cfg, entry.pendingUpload)) {
      const { pendingUpload, ...rest } = entry;
      saveEntry(cfg, key, rest);
      retried++;
    }
  }

  let summarized = 0;
  const results = [];
  for (const t of pickWork(transcripts, readLedger(cfg), now, cfg.sessionSweepQuietHours)) {
    if (summarized >= cfg.sessionSweepPerRun) break;
    const result = await summarizeSession({ transcript: t.file, sessionId: t.sessionId, cwd: cwdOf(t.file), reason: "sweep" });
    if (result === "unchanged") {
      saveEntry(cfg, t.sessionId, { ...readLedger(cfg)[t.sessionId], size: t.size });
    } else if (result !== "short" && result !== "busy" && result !== "off") {
      summarized++;
    }
    results.push({ session: t.sessionId.slice(0, 8), result: path.basename(String(result)) });
  }
  return { summarized, retried, results };
}

// One line when a run starts and one when it ends. A "start" with no "end" after it means
// something killed the run, which leaves no other trace.
function noteRun(text) {
  try {
    const dir = getConfig().sessionLogDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, ".sweep-runs.log"), `${new Date().toISOString()} ${text}${os.EOL}`);
  } catch { /* the log must never stop the sweep */ }
}

if (require.main === module) {
  noteRun("start");
  main().then(
    (r) => { noteRun(`end ${JSON.stringify(r)}`); console.log(JSON.stringify(r)); process.exit(0); },
    (err) => {
      noteRun("end with error");
      const dir = getConfig().sessionLogDir;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, ".worker-errors.log"), `${new Date().toISOString()} sweep: ${String(err && err.message).slice(0, 300)}${os.EOL}`);
      } catch { /* nothing else to do */ }
      process.exit(0);
    },
  );
}

module.exports = { main, listTranscripts, pickWork, cwdOf, adoptOldLogs };
