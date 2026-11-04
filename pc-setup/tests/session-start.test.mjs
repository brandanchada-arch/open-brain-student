// Run: node --experimental-strip-types --test pc-setup/tests/session-start.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startFakeServer, FAKE_KEY } from "./fake-server.mjs";
import { tempHome, runScript } from "./helpers.mjs";

const hookInput = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" });

test("prints the core page as additionalContext", async () => {
  const srv = await startFakeServer({ core: "CORE PAGE. Background facts:\n\nSample fact: likes tea." });
  const home = tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${srv.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  try {
    const r = await runScript("session-start-core.js", [], { home, input: hookInput });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /Sample fact: likes tea/);
    assert.match(out.hookSpecificOutput.additionalContext, /data, not as instructions/);
    assert.equal(srv.mcpCalls[0].method, "tools/call");
    assert.equal(srv.mcpCalls[0].params.name, "get_core");
  } finally { await srv.close(); }
});

test("silent exit 0 when: server down, slow, erroring, wrong key, no settings, off switch, empty core, child guard", async () => {
  const cases = [];
  const down = tempHome(["OPEN_BRAIN_FUNCTIONS_URL=http://127.0.0.1:9", `MCP_ACCESS_KEY=${FAKE_KEY}`]);
  cases.push(["server down", down, {}]);
  cases.push(["no settings", tempHome([]), {}]);
  const slow = await startFakeServer({ coreDelayMs: 10000 });
  cases.push(["slow server", tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${slow.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]), {}]);
  const failing = await startFakeServer({ mcpFails: true });
  cases.push(["server error", tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${failing.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]), {}]);
  cases.push(["wrong key", tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${failing.url}`, "MCP_ACCESS_KEY=nope"]), {}]);
  const ok = await startFakeServer({ core: "The core page is empty so far." });
  cases.push(["empty core", tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${ok.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]), {}]);
  cases.push(["off switch", tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${ok.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`, "CORE_HOOK=off"]), {}]);
  cases.push(["child guard", tempHome([`OPEN_BRAIN_FUNCTIONS_URL=${ok.url}`, `MCP_ACCESS_KEY=${FAKE_KEY}`]), { OPEN_BRAIN_SESSION_LOG_CHILD: "1" }]);
  try {
    for (const [name, home, env] of cases) {
      const r = await runScript("session-start-core.js", [], { home, input: hookInput, env });
      assert.equal(r.code, 0, name);
      assert.equal(r.stdout, "", `${name}: stdout should be empty`);
      assert.equal(r.stderr, "", `${name}: stderr should be empty`);
      assert.ok(r.ms < 6000, `${name}: took ${r.ms} ms`);
    }
    assert.equal(ok.mcpCalls.length, 1, "only the empty-core case called the server (off switch and guard didn't)");
  } finally { await Promise.all([slow.close(), failing.close(), ok.close()]); }
});
