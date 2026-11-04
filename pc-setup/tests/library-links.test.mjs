// Fix 4 (P7): the backup keeps library_links (takeaway thought -> its library source).
// Uses the existing fakes: fakeDb (in-memory, refuses writes) and the local fake server that runs
// the REAL export-brain handler. Made-up ids only.
// Run: node --experimental-strip-types --test pc-setup/tests/library-links.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { handleExport } from "../../supabase/functions/export-brain/handler.ts";
import { fakeDb, OWNER, OTHER, id } from "./fake-supabase.mjs";
import { startFakeServer, FAKE_KEY } from "./fake-server.mjs";
import { tempHome, runScript } from "./helpers.mjs";

const KEY = "test-key-not-real";

// 5 owner library entries (one with 3 links, one with none) + one entry belonging to someone else.
function tables() {
  const library = [1, 2, 3, 4, 5].map((n) => ({ id: id(900 + n), user_id: OWNER, title: `Entry ${n}`, content: "Demo", embedding: [1] }));
  library.push({ id: id(950), user_id: OTHER, title: "Not mine", content: "x" });
  const link = (t, l, note) => ({ thought_id: id(t), library_id: id(l), note, created_at: "2026-10-22T00:00:00Z" });
  return {
    thoughts: [{ id: id(1), user_id: OWNER, content: "Made-up takeaway", archived_at: null }],
    library,
    library_links: [
      link(1, 901, "takeaway A"), link(2, 901, "takeaway B"), link(3, 901, "takeaway C"), // 3 links on one entry
      link(4, 903, null), link(5, 905, "last one"),
      link(6, 950, "someone else's entry"),
    ],
    thought_links: [],
  };
}

const call = (db, body) => handleExport(new Request("http://local/export-brain", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { db, accessKey: KEY, ownerId: OWNER });

async function exportAll(db, body) {
  const rows = [];
  const pages = [];
  let after = null;
  for (;;) {
    const res = await call(db, { ...body, after });
    assert.equal(res.status, 200);
    const page = await res.json();
    pages.push(page);
    rows.push(...page.rows);
    if (page.done) return { rows, pages };
    assert.ok(page.next_after && page.next_after !== after, "paging moves forward");
    after = page.next_after;
    assert.ok(pages.length < 100);
  }
}

test("export-brain: library_links are the owner's only, all of them, across small pages", async () => {
  const db = fakeDb(tables());
  for (const limit of [1, 2, 3, 50]) {
    const { rows, pages } = await exportAll(db, { table: "library_links", limit });
    const notes = rows.map((r) => r.note).sort();
    assert.deepEqual(notes, [null, "last one", "takeaway A", "takeaway B", "takeaway C"].sort(), `limit ${limit}`);
    assert.ok(!rows.some((r) => r.library_id === id(950)), "nothing from someone else's entry");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["created_at", "library_id", "note", "thought_id"]);
    if (limit === 1) assert.ok(pages.some((p) => p.count === 0 && !p.done), "an entry with no links gives an empty page, not the end");
  }
});

test("export-brain: library_links reads only, and only through the owner's library ids", async () => {
  const db = fakeDb(tables());
  await exportAll(db, { table: "library_links", limit: 2 });
  // every page: from:library + eq:user_id, then from:library_links + in:library_id
  const froms = db.calls.filter((c) => c.startsWith("from:"));
  assert.equal(froms.filter((c) => c === "from:library").length, db.calls.filter((c) => c === "eq:user_id").length);
  assert.ok(froms.includes("from:library_links"));
  assert.equal(froms.filter((c) => c === "from:library_links").length, db.calls.filter((c) => c === "in:library_id").length);
  // (fakeDb throws on insert/update/upsert/delete, so reaching here also proves no writes)
});

test("export-brain: library_links rejects a bad cursor like the other tables", async () => {
  const db = fakeDb(tables());
  assert.equal((await call(db, { table: "library_links", after: "1 or 1=1" })).status, 400);
  assert.equal((await call(db, { table: "library_links" })).status, 200);
});

test("weekly export: the backup JSON includes library_links (owner only) with a count", async () => {
  const srv = await startFakeServer({ tables: tables() });
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    const r = await runScript("weekly-export.js", [], { home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const dir = path.join(home, "open-brain-export", "backups");
    const b = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"));
    assert.equal(b.library_links.length, 5);
    assert.equal(b.counts.library_links, 5);
    assert.ok(!JSON.stringify(b).includes("someone else's entry"));
    assert.ok(!JSON.stringify(b).includes(OWNER), "no user id in backup");
    assert.match(r.stdout, /5 library links/);
    const check = await runScript("weekly-export.js", ["--check"], { home });
    assert.match(check.stdout, /OK library_links: first page has/);
  } finally { await srv.close(); }
});

test("weekly export against an older export-brain: backup still made, without library_links, with a warning", async () => {
  // A stand-in for the export-brain deployed before this fix: same handler, but it refuses library_links.
  const db = fakeDb(tables());
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    if (JSON.parse(body).table === "library_links") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "table must be one of: thoughts, library, thought_links" }));
      return;
    }
    const r = await handleExport(new Request("http://127.0.0.1/export-brain", { method: "POST", headers: req.headers, body }),
      { db, accessKey: FAKE_KEY, ownerId: OWNER });
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(await r.text());
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=http://127.0.0.1:${server.address().port}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    const r = await runScript("weekly-export.js", [], { home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /library_links were NOT backed up/);
    const dir = path.join(home, "open-brain-export", "backups");
    const b = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"));
    assert.equal(b.library_links, null);
    assert.equal(b.counts.library_links, null);
    assert.equal(b.library.length, 5);
  } finally { await new Promise((ok) => server.close(ok)); }
});
