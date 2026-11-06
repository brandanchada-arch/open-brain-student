// THE ONE PLACE where PC scripts talk to Open Brain over the internet.
// - callTool():       JSON-RPC "tools/call" on the open-brain-mcp function
//                     (get_core, add_session_log, ...). Auth: Bearer MCP_ACCESS_KEY.
// - callExport():     one page from the read-only export-brain function.
// Every call has a timeout, so nothing can hang a hook or the export.
"use strict";
const { getConfig } = require("./config");

async function postJson(url, key, body, timeoutMs) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && (data.error?.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(`${new URL(url).pathname} failed: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  if (data === null) throw new Error(`${new URL(url).pathname} did not return JSON`);
  return data;
}

function requireConfig(cfg) {
  if (!cfg.ready) {
    throw new Error(`Settings missing: put OPEN_BRAIN_FUNCTIONS_URL and MCP_ACCESS_KEY in ${cfg.envFile}`);
  }
}

let rpcId = 0;
// Returns the tool's text answer. Throws on any error.
async function callTool(name, args = {}, { timeoutMs = 10000, cfg = getConfig() } = {}) {
  requireConfig(cfg);
  const data = await postJson(`${cfg.functionsUrl}/open-brain-mcp`, cfg.accessKey,
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, timeoutMs);
  if (data.error) throw new Error(`${name}: ${data.error.message || "error"}`);
  const result = data.result || {};
  const text = (result.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  if (result.isError) throw new Error(`${name}: ${text || "tool error"}`);
  return text;
}

const getCore = (opts) => callTool("get_core", {}, opts);
const addSessionLog = ({ title, summary, project, aboutMe }, opts) =>
  callTool("add_session_log", {
    title, summary,
    ...(project ? { project } : {}),
    ...(aboutMe && aboutMe.length ? { about_me: aboutMe } : {}),
  }, opts);

// body: { table, include_archived, after, limit }
async function callExport(body, { timeoutMs = 120000, cfg = getConfig() } = {}) {
  requireConfig(cfg);
  return postJson(`${cfg.functionsUrl}/export-brain`, cfg.accessKey, body, timeoutMs);
}

module.exports = { callTool, getCore, addSessionLog, callExport };
