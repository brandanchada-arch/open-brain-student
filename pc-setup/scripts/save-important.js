#!/usr/bin/env node
// Saves everything Brandan typed in one Claude Code session to ai-notes\important-chats,
// in order and untrimmed. Makes no AI call. Saving the same chat again updates its one file.
//   node save-important.js "<short title>" [session id]
// With no session id, it uses the most recently active session.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listTranscripts } = require("./session-sweep");

const SKIP = /^<(command-|local-command|bash-|user-memory|task-notification|side-sessions-event|cross-session)/;

function myWords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary) continue;
    const c = e.message && e.message.content;
    if (Array.isArray(c) && c.some((x) => x && x.type === "tool_result")) continue;
    const raw = typeof c === "string" ? c : (c || []).filter((x) => x && x.type === "text").map((x) => x.text).join("\n");
    const text = raw.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!text || SKIP.test(text) || /^\[(SYSTEM NOTIFICATION|Image:)/.test(text)) continue;
    out.push({ when: String(e.timestamp || "").slice(0, 16).replace("T", " "), text });
  }
  return out;
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "chat";
}

function save(title, sessionId, dir = path.join(os.homedir(), "ai-notes", "important-chats")) {
  const all = listTranscripts();
  const t = sessionId
    ? all.find((x) => x.sessionId === sessionId)
    : all.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!t) throw new Error("Couldn't find that chat's history.");
  const words = myWords(t.file);
  if (!words.length) throw new Error("That chat has no messages to save.");

  fs.mkdirSync(dir, { recursive: true });
  const id8 = t.sessionId.slice(0, 8);
  const existing = fs.readdirSync(dir).find((n) => n.endsWith(`-${id8}.md`));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const name = existing || `${today}-${slug(title)}-${id8}.md`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    `# ${title || "Important chat"}: my words`,
    "",
    "Everything I typed or dictated in this chat, in order. Dictation errors are left as they were.",
    `Session id: ${t.sessionId}. The full chat stays in Claude Code's history on this PC for about a year.`,
    "",
    ...words.map((w, i) => `## ${i + 1}. ${w.when} UTC\n\n${w.text}\n`),
  ].join("\n"), "utf8");
  return { file, messages: words.length };
}

if (require.main === module) {
  try {
    const { file, messages } = save(process.argv[2], process.argv[3]);
    console.log(`Saved ${messages} messages to ${file}`);
  } catch (err) {
    console.log(`Not saved: ${err.message}`);
  }
}

module.exports = { save, myWords, slug };
