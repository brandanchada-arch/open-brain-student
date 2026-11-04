// Run: node --experimental-strip-types --test pc-setup/tests/weekly-export.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startFakeServer, FAKE_KEY } from "./fake-server.mjs";
import { tempHome, runScript, SCRIPTS } from "./helpers.mjs";
import { OWNER, OTHER, id } from "./fake-supabase.mjs";

const require = createRequire(import.meta.url);
const exp = require(path.join(SCRIPTS, "weekly-export.js"));

function sampleTables() {
  const thoughts = [];
  for (let i = 1; i <= 30; i++) {
    thoughts.push({ id: id(i), user_id: OWNER, content: `Made-up sample thought number ${i}: "quotes", colons: and / slashes?`,
      metadata: { tags: ["demo", "test tag"], category: "idea" }, embedding: [0.1, 0.2],
      created_at: "2026-01-02T03:04:05Z", archived_at: i <= 3 ? "2026-10-22T00:00:00Z" : null });
  }
  thoughts.push({ id: id(999), user_id: OTHER, content: "not the owner", archived_at: null });
  thoughts.push({ id: id(40), user_id: OWNER, content: "y".repeat(120_000), metadata: {}, archived_at: null, created_at: "2026-02-01T00:00:00Z" });
  return {
    thoughts,
    library: [
      { id: id(800), user_id: OWNER, title: 'Week 3: CON/AUX* "Pricing" <notes>', content: "Demo class notes.", doc_type: "class-notes",
        course: "DEMO-101", topic: "pricing", tags: ["x"], embedding: [1], created_at: "2026-03-01T00:00:00Z" },
    ],
    thought_links: [{ id: id(700), user_id: OWNER, source_thought_id: id(4), target_thought_id: id(5), similarity_score: 0.9 }],
  };
}

test("full export: markdown per non-archived item, backup with archived + links, no embeddings", async () => {
  const srv = await startFakeServer({ tables: sampleTables() });
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    const r = await runScript("weekly-export.js", [], { home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = path.join(home, "open-brain-export");
    const tFiles = fs.readdirSync(path.join(out, "thoughts"));
    assert.equal(tFiles.length, 28); // 30 + 1 big - 3 archived; other user excluded
    for (const f of tFiles) {
      assert.match(f, /^[0-9a-f-]{36}(-[a-z0-9-]{1,40})?\.md$/);
      assert.ok(f.length <= 80);
    }
    const lFiles = fs.readdirSync(path.join(out, "library"));
    assert.deepEqual(lFiles, [`${id(800)}-week-3-con-aux-pricing-notes.md`]);
    const lib = fs.readFileSync(path.join(out, "library", lFiles[0]), "utf8");
    assert.match(lib, /^---\nid: "/);
    assert.match(lib, /title: "Week 3: CON\/AUX\* \\"Pricing\\" <notes>"/);
    assert.match(lib, /course: "DEMO-101"/);
    const one = fs.readFileSync(path.join(out, "thoughts", tFiles.find((f) => f.startsWith(id(4)))), "utf8");
    assert.match(one, /tags: \["demo", "test tag"\]/);
    assert.match(one, /category: "idea"/);
    const backups = fs.readdirSync(path.join(out, "backups"));
    assert.equal(backups.length, 1);
    const b = JSON.parse(fs.readFileSync(path.join(out, "backups", backups[0]), "utf8"));
    assert.equal(b.thoughts.length, 31);
    assert.equal(b.counts.archived_thoughts, 3);
    assert.equal(b.thought_links.length, 1);
    assert.equal(b.library.length, 1);
    const raw = JSON.stringify(b);
    assert.ok(!raw.includes('"embedding"'), "no embeddings in backup");
    assert.ok(!raw.includes(OWNER), "no user id in backup");
    assert.ok(!raw.includes("not the owner"));
    assert.ok(fs.existsSync(path.join(out, "export-log.txt")));
  } finally { await srv.close(); }
});

test("second run the same week exits early; --force re-runs without deleting and reports gone items", async () => {
  const tables = sampleTables();
  const srv = await startFakeServer({ tables });
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    assert.equal((await runScript("weekly-export.js", [], { home })).code, 0);
    const again = await runScript("weekly-export.js", [], { home });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /already exists/);

    // A thought gets archived and a title changes: files are kept, the change is reported.
    tables.thoughts.find((t) => t.id === id(10)).archived_at = "2026-11-01T00:00:00Z";
    tables.thoughts.find((t) => t.id === id(11)).content = "Completely different text now";
    const out = path.join(home, "open-brain-export");
    const before = fs.readdirSync(path.join(out, "thoughts")).sort();
    const forced = await runScript("weekly-export.js", ["--force"], { home });
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.match(forced.stdout, /1 file\(s\) are no longer in the brain/);
    assert.match(forced.stdout, new RegExp(id(10)));
    assert.match(forced.stdout, /0 new, 1 updated/);
    const after = fs.readdirSync(path.join(out, "thoughts")).sort();
    assert.deepEqual(after, before, "same file names, nothing deleted, no duplicate for the renamed one");
    assert.equal(fs.readdirSync(path.join(out, "backups")).length, 2, "earlier backup kept");
  } finally { await srv.close(); }
});

test("refuses a folder inside a git repo or OneDrive, and refuses bad settings", async () => {
  const srv = await startFakeServer({ tables: sampleTables() });
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    const repo = path.join(home, "some-repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const r1 = await runScript("weekly-export.js", ["--dir", path.join(repo, "export")], { home });
    assert.equal(r1.code, 1);
    assert.match(r1.stdout, /inside a git repository/);
    assert.ok(!fs.existsSync(path.join(repo, "export")));

    const od = path.join(home, "OneDrive");
    const r2 = await runScript("weekly-export.js", ["--dir", path.join(od, "export")], { home, env: { OneDrive: od } });
    assert.equal(r2.code, 1);
    assert.match(r2.stdout, /OneDrive/);

    const r3 = await runScript("weekly-export.js", ["--dir", path.join(home, "Documents", "OneDrive - School", "x")], { home });
    assert.equal(r3.code, 1);

    // Plain http to a non-local host is never used (key would travel unencrypted).
    const bad = tempHome(["OPEN_BRAIN_FUNCTIONS_URL=http://example.invalid/functions/v1", `MCP_ACCESS_KEY=${FAKE_KEY}`]);
    const r4 = await runScript("weekly-export.js", [], { home: bad });
    assert.equal(r4.code, 1);
    assert.match(r4.stdout, /Settings missing/);
    // Wrong key → fails with exit 1, writes no markdown.
    const wrong = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, "MCP_ACCESS_KEY=wrong"]);
    const r5 = await runScript("weekly-export.js", [], { home: wrong });
    assert.equal(r5.code, 1);
    assert.match(r5.stderr, /Unauthorized/);
    assert.equal(fs.readdirSync(path.join(wrong, "open-brain-export", "thoughts")).length, 0);
  } finally { await srv.close(); }
});

test("--check writes nothing", async () => {
  const srv = await startFakeServer({ tables: sampleTables() });
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    const r = await runScript("weekly-export.js", ["--check"], { home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Connection works/);
    assert.ok(!fs.existsSync(path.join(home, "open-brain-export")));
  } finally { await srv.close(); }
});

test("helpers: ISO week, slugs, front matter escaping", () => {
  assert.equal(exp.isoWeek(new Date(2026, 10, 4)), "2026-W45");
  assert.equal(exp.isoWeek(new Date(2027, 0, 1)), "2026-W53");
  assert.equal(exp.slug("Café: AUX/NUL?  ¿Qué tal?"), "cafe-aux-nul-que-tal");
  assert.throws(() => exp.fileNameFor("../../evil", "x"));
  const fm = exp.frontMatter({ title: 'a "b"\nc', tags: ["x"], empty: "" });
  assert.equal(fm, '---\ntitle: "a \\"b\\"\\nc"\ntags: ["x"]\n---\n');
});
