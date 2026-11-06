// Run: node --experimental-strip-types --test pc-setup/tests/session-sweep.test.mjs
// One summary per session: the button, the backup sweep and coming back later. Uses a fake
// `claude` and a fake server, so nothing real is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeServer, FAKE_KEY } from "./fake-server.mjs";
import { tempHome, runScript } from "./helpers.mjs";

const FAKE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-bin");
const ID = "abcd1234-5678-4abc-8def-000000000001";

const line = (role, text) => JSON.stringify({ type: role, cwd: "C:\\demo\\my-project", message: { role, content: role === "assistant" ? [{ type: "text", text }] : text } });
const turn = (i) => [line("user", `Made-up question ${i}. ${"detail ".repeat(60)}`), line("assistant", `Made-up answer ${i}. ${"explain ".repeat(60)}`)];

function writeSession(home, { id = ID, turns = 4, hoursAgo = 48, dir = "C--demo-my-project" } = {}) {
  const folder = path.join(home, ".claude", "projects", dir);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(file, Array.from({ length: turns }, (_, i) => turn(i)).flat().join("\n"));
  const when = new Date(Date.now() - hoursAgo * 3600 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

function setup(lines = []) {
  const home = tempHome(["SESSION_LOG_ON_END=off", ...lines]);
  const log = path.join(home, "fake-claude.log");
  const env = { PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log };
  const aiRuns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const summaries = () => {
    const d = path.join(home, "claude-session-logs");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")) : [];
  };
  return { home, env, log, aiRuns, summaries };
}

const sweep = (s) => runScript("session-sweep.js", [], { home: s.home, env: s.env });
const save = (s, id = ID) => runScript("session-save.js", [id], { home: s.home, env: s.env });

test("the button saves right away, even on an active chat, and pressing it again costs nothing", async () => {
  const s = setup();
  writeSession(s.home, { hoursAgo: 0 });
  assert.match((await save(s)).stdout, /Summary saved/);
  assert.equal(s.aiRuns(), 1);
  assert.match((await save(s)).stdout, /Nothing new/);
  assert.equal(s.aiRuns(), 1, "no second AI call");
  assert.equal(s.summaries().length, 1);
});

test("the button saves a short chat the sweep would skip, but not a nearly empty one", async () => {
  const s = setup();
  writeSession(s.home, { turns: 1 });
  assert.match((await save(s)).stdout, /Summary saved/);
  assert.equal(s.aiRuns(), 1);
  const empty = setup();
  const file = writeSession(empty.home, { turns: 1 });
  fs.writeFileSync(file, line("user", "hi"));
  assert.match((await save(empty)).stdout, /too short/);
  assert.equal(empty.aiRuns(), 0);
});

test("the sweep skips a chat already saved with the button", async () => {
  const s = setup();
  writeSession(s.home);
  await save(s);
  await sweep(s);
  assert.equal(s.aiRuns(), 1, "button and sweep together still make one AI call");
});

test("coming back later updates the same summary and sends only what's new", async () => {
  const s = setup();
  const file = writeSession(s.home, { hoursAgo: 0 });
  await save(s);
  fs.appendFileSync(file, `\n${turn(9).join("\n").replace(/Made-up question 9/, "BRAND NEW QUESTION")}`);
  await save(s);
  assert.equal(s.aiRuns(), 2);
  assert.equal(s.summaries().length, 1, "still one summary file");
  const prompt = fs.readFileSync(`${s.log}.prompt`, "utf8");
  assert.match(prompt, /BRAND NEW QUESTION/);
  assert.doesNotMatch(prompt, /Made-up question 0/, "old messages aren't sent again");
  assert.match(prompt, /<previous>/);
});

test("the sweep waits for quiet, and works one session per run, newest first", async () => {
  const s = setup();
  writeSession(s.home, { id: "11111111-0000-4000-8000-000000000000", hoursAgo: 1 });
  writeSession(s.home, { id: "22222222-0000-4000-8000-000000000000", hoursAgo: 72 });
  writeSession(s.home, { id: "33333333-0000-4000-8000-000000000000", hoursAgo: 48 });
  await sweep(s);
  assert.deepEqual(s.summaries().map((f) => f.match(/_([0-9a-z]{8})\.md$/)[1]), ["33333333"]);
  await sweep(s);
  assert.equal(s.aiRuns(), 2);
  await sweep(s);
  assert.equal(s.aiRuns(), 2, "the recent session waits, so nothing is left to do");
});

test("short chats make no AI call and aren't read again", async () => {
  const s = setup();
  writeSession(s.home, { turns: 1 });
  await sweep(s);
  await sweep(s);
  assert.equal(s.aiRuns(), 0);
  assert.equal(s.summaries().length, 0);
});

test("old summaries count as done, so nothing gets summarized twice", async () => {
  const s = setup();
  writeSession(s.home);
  const dir = path.join(s.home, "claude-session-logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-11-05_1933_my-project_abcd1234.md"), "# Old title\n\n- Date: x\n\n## Decisions\n- Old");
  await sweep(s);
  assert.equal(s.aiRuns(), 0);
});

test("the off switch and the test-run folders are respected", async () => {
  const off = setup(["SESSION_SWEEP=off"]);
  writeSession(off.home);
  await sweep(off);
  assert.equal(off.aiRuns(), 0);
  const drills = setup();
  writeSession(drills.home, { dir: "C--Temp-nl-drill-abc-clean" });
  await sweep(drills);
  assert.equal(drills.aiRuns(), 0);
});

test("uploads carry the session's id and date, and a failed upload retries without a new AI call", async () => {
  const srv = await startFakeServer();
  const s = setup([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`, "SESSION_LOG_UPLOAD=on"]);
  try {
    writeSession(s.home);
    await sweep(s);
    const a = srv.mcpCalls.find((c) => c.params?.name === "add_session_log").params.arguments;
    assert.equal(a.session_key, ID);
    assert.ok(Date.now() - Date.parse(a.session_at) > 40 * 3600 * 1000, "keeps the session's own date");

    const ledgerFile = path.join(s.home, "claude-session-logs", ".session-ledger.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    ledger[ID].pendingUpload = { title: "t", summary: "s", sessionKey: ID };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    const before = srv.mcpCalls.length;
    await sweep(s);
    assert.equal(srv.mcpCalls.length, before + 1);
    assert.equal(s.aiRuns(), 1);
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, "utf8"))[ID].pendingUpload, undefined);
  } finally { await srv.close(); }
});

test("the end-of-session hook is off unless switched on", async () => {
  const s = setup();
  const file = writeSession(s.home);
  await runScript("session-end-log.js", [], { home: s.home, env: s.env, input: JSON.stringify({ session_id: ID, transcript_path: file, cwd: "C:\\demo" }) });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(s.aiRuns(), 0);
});
