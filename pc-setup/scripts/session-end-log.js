#!/usr/bin/env node
// Claude Code SessionEnd hook: starts session-log-worker.js in the background and returns
// immediately. The worker writes a short summary (decisions, lessons, next steps) to
// %USERPROFILE%\claude-session-logs. Full transcripts are never copied or uploaded.
//
// Rules: returns in well under a second, exits 0 on ANY failure, prints nothing.
// Off switch: SESSION_LOGS=off in %USERPROFILE%\.open-brain\.env
//
// LOOP GUARD: the worker summarizes with `claude -p`, which is itself a Claude Code session
// and fires this same hook when it ends. The worker sets OPEN_BRAIN_SESSION_LOG_CHILD=1 for
// that child, and this hook does nothing when it sees it.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const quit = () => process.exit(0);
setTimeout(quit, 3000); // safety net
process.on("uncaughtException", quit);
process.on("unhandledRejection", quit);

const GUARD = "OPEN_BRAIN_SESSION_LOG_CHILD";

function readStdin(maxMs) {
  return new Promise((resolve) => {
    let data = "";
    const done = () => resolve(data);
    setTimeout(done, maxMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { data += d; if (data.length > 1e6) done(); });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function main() {
  if (process.env[GUARD] === "1") return; // we are inside the summarizer's own session

  const { getConfig } = require("./lib/config");
  const cfg = getConfig();
  if (!cfg.sessionLogs) return;

  let input = {};
  try { input = JSON.parse(await readStdin(1500)); } catch { return; }
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (!transcript || !fs.existsSync(transcript)) return;
  if (fs.statSync(transcript).size < 2000) return; // obviously too short to be worth a summary

  const worker = path.join(__dirname, "session-log-worker.js");
  const child = spawn(process.execPath, [
    worker,
    transcript,
    String(input.session_id || ""),
    String(input.cwd || ""),
    String(input.reason || ""),
  ], {
    detached: true,       // keeps running after Claude Code exits
    stdio: "ignore",
    windowsHide: true,    // no console window on Windows
    env: { ...process.env, [GUARD]: "1" },
  });
  child.on("error", quit);
  child.unref();
}

main().then(quit, quit);
