#!/usr/bin/env node
// What the Save summary button runs. Summarizes one session right now, or only what's new
// since its last summary. Prints one plain line saying what happened.
//   node session-save.js <session id>
"use strict";
const { summarizeSession } = require("./session-log-worker");
const { listTranscripts, cwdOf } = require("./session-sweep");

const MESSAGES = {
  off: "Session summaries are switched off.",
  short: "This chat is too short to need a summary.",
  unchanged: "Already saved. Nothing new since the last summary.",
  busy: "A summary for this chat is already being saved.",
};

async function save(sessionId) {
  const t = listTranscripts().find((x) => x.sessionId === sessionId);
  if (!t) return "Couldn't find this chat's history, so nothing was saved.";
  const result = await summarizeSession({ transcript: t.file, sessionId, cwd: cwdOf(t.file), reason: "button", pressed: true });
  return MESSAGES[result] || "Summary saved.";
}

async function cli(sessionId) {
  try {
    console.log(await save(String(sessionId || "")));
  } catch (err) {
    console.log(`The summary failed: ${String(err && err.message).slice(0, 160)}`);
  }
  process.exit(0);
}

if (require.main === module) cli(process.argv[2]);

module.exports = { save, cli };
