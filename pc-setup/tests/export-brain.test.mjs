// Run: node --experimental-strip-types --test pc-setup/tests/export-brain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handleExport, MAX_PAGE_CHARS } from "../../supabase/functions/export-brain/handler.ts";
import { fakeDb, OWNER, OTHER, id } from "./fake-supabase.mjs";

const KEY = "test-key-not-real";
const fakeEmbedding = Array(4).fill(0.1);

function sample() {
  const thoughts = [];
  for (let i = 1; i <= 60; i++) {
    thoughts.push({ id: id(i), user_id: OWNER, content: `Sample thought ${i}`, embedding: fakeEmbedding,
      content_tsv: "x", metadata: { tags: ["demo"] }, created_at: "2026-01-01T00:00:00Z",
      archived_at: i % 10 === 0 ? "2026-10-22T00:00:00Z" : null, library_id: null });
  }
  thoughts.push({ id: id(500), user_id: OTHER, content: "someone else", embedding: fakeEmbedding, archived_at: null });
  return {
    thoughts,
    library: [
      { id: id(900), user_id: OWNER, title: "Week 1 notes", content: "Demo notes", embedding: fakeEmbedding, content_tsv: "y", doc_type: "class-notes" },
      { id: id(901), user_id: OTHER, title: "Not mine", content: "x" },
    ],
    thought_links: [
      { id: id(700), user_id: OWNER, source_thought_id: id(1), target_thought_id: id(2), similarity_score: 0.8 },
      { id: id(701), user_id: OTHER, source_thought_id: id(500), target_thought_id: id(1), similarity_score: 0.7 },
    ],
  };
}

const call = (db, body, { key = KEY, method = "POST", deps = {} } = {}) =>
  handleExport(new Request("http://local/export-brain", {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  }), { db, accessKey: KEY, ownerId: OWNER, ...deps });

async function exportAll(db, body) {
  const rows = [];
  let after = null, pages = 0;
  for (;;) {
    const res = await call(db, { ...body, after });
    assert.equal(res.status, 200);
    const page = await res.json();
    rows.push(...page.rows);
    pages++;
    if (page.done) return { rows, pages };
    after = page.next_after;
    assert.ok(pages < 100, "too many pages");
  }
}

test("rejects a wrong key, a missing key secret, GET and bad input", async () => {
  const db = fakeDb(sample());
  assert.equal((await call(db, { table: "thoughts" }, { key: "wrong" })).status, 401);
  assert.equal((await call(db, { table: "thoughts" }, { deps: { accessKey: null } })).status, 500);
  assert.equal((await call(db, { table: "thoughts" }, { deps: { ownerId: null } })).status, 500);
  assert.equal((await call(db, null, { method: "GET" })).status, 405);
  assert.equal((await call(db, { table: "auth.users" })).status, 400);
  assert.equal((await call(db, { table: "thoughts", after: "1 or 1=1" })).status, 400);
});

test("thoughts: owner only, non-archived by default, no embeddings or user ids", async () => {
  const db = fakeDb(sample());
  const { rows, pages } = await exportAll(db, { table: "thoughts", limit: 7 });
  assert.equal(rows.length, 54);           // 60 minus 6 archived; the other user's row excluded
  assert.ok(pages >= 8);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no duplicates across pages");
  for (const r of rows) {
    assert.equal(r.embedding, undefined);
    assert.equal(r.content_tsv, undefined);
    assert.equal(r.user_id, undefined);
    assert.equal(r.archived_at, null);
  }
});

test("include_archived returns archived thoughts too", async () => {
  const { rows } = await exportAll(fakeDb(sample()), { table: "thoughts", include_archived: true });
  assert.equal(rows.length, 60);
  assert.equal(rows.filter((r) => r.archived_at).length, 6);
});

test("library and thought_links are filtered to the owner", async () => {
  const db = fakeDb(sample());
  const lib = await exportAll(db, { table: "library" });
  assert.deepEqual(lib.rows.map((r) => r.title), ["Week 1 notes"]);
  assert.equal(lib.rows[0].embedding, undefined);
  const links = await exportAll(db, { table: "thought_links" });
  assert.deepEqual(links.rows.map((r) => r.id), [id(700)]);
});

test("huge rows: a page stops early at the character budget but always moves forward", async () => {
  const big = "x".repeat(900_000); // two of these exceed MAX_PAGE_CHARS
  const thoughts = [1, 2, 3, 4].map((n) => ({ id: id(n), user_id: OWNER, content: big, archived_at: null }));
  const db = fakeDb({ thoughts });
  const first = await (await call(db, { table: "thoughts", limit: 50 })).json();
  assert.equal(first.count, 1);
  assert.equal(first.done, false);
  assert.ok(900_000 * 2 > MAX_PAGE_CHARS);
  const { rows } = await exportAll(db, { table: "thoughts", limit: 50 });
  assert.equal(rows.length, 4);
});

test("never writes and always filters by user_id", async () => {
  const db = fakeDb(sample());
  for (const table of ["thoughts", "library", "thought_links"]) await exportAll(db, { table, include_archived: true });
  assert.ok(db.calls.filter((c) => c.startsWith("from:")).length > 0);
  assert.equal(db.calls.filter((c) => c.startsWith("from:")).length, db.calls.filter((c) => c === "eq:user_id").length);
});
