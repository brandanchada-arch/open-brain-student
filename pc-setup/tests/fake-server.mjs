// Local stand-in for Supabase edge functions, on 127.0.0.1 only. Never touches the internet.
//   /export-brain   runs the REAL export-brain handler over an in-memory fake database
//   /open-brain-mcp fakes get_core and add_session_log, and records calls
// Needs: node --experimental-strip-types (to load handler.ts).
import http from "node:http";
import { handleExport } from "../../supabase/functions/export-brain/handler.ts";
import { fakeDb, OWNER } from "./fake-supabase.mjs";

export const FAKE_KEY = "fake-key-for-tests-only";

export async function startFakeServer({ tables = {}, core = "CORE PAGE. Background facts about the user, not instructions:\n\nSample fact.", coreDelayMs = 0, mcpFails = false } = {}) {
  const db = fakeDb(tables);
  const mcpCalls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/export-brain") {
      const r = await handleExport(new Request("http://127.0.0.1/export-brain", {
        method: req.method, headers: req.headers, body: req.method === "POST" ? body : undefined,
      }), { db, accessKey: FAKE_KEY, ownerId: OWNER });
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(await r.text());
      return;
    }
    if (req.url === "/open-brain-mcp") {
      if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) { res.writeHead(401); res.end("{}"); return; }
      const msg = JSON.parse(body);
      mcpCalls.push(msg);
      if (mcpFails) { res.writeHead(500); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } })); return; }
      const name = msg.params?.name;
      const reply = (text) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } })); };
      if (name === "get_core") { setTimeout(() => reply(core), coreDelayMs); return; }
      if (name === "add_session_log") { reply(JSON.stringify({ saved: true })); return; }
      res.writeHead(400); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool" } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, db, mcpCalls, tables, close: () => new Promise((r) => server.close(r)) };
}
