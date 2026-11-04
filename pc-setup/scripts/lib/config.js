// Reads settings from %USERPROFILE%\.open-brain\.env (outside every repo).
// The file is only PARSED as KEY=VALUE lines, never run. Keys are never printed.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENV_DIR = path.join(os.homedir(), ".open-brain");
const ENV_FILE = path.join(ENV_DIR, ".env");

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim(); // Notepad may add a BOM
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnv() {
  try {
    return parseEnv(fs.readFileSync(ENV_FILE, "utf8"));
  } catch {
    return {};
  }
}

const isOn = (v, dflt) => {
  if (v == null || v === "") return dflt;
  return /^(on|yes|true|1)$/i.test(String(v).trim());
};

// A key must never travel over plain http, except to this computer (tests).
function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return u.replace(/\/+$/, "");
  return null;
}

function getConfig() {
  const env = loadEnv();
  const base = checkUrl(env.OPEN_BRAIN_FUNCTIONS_URL || "");
  const key = env.MCP_ACCESS_KEY && !env.MCP_ACCESS_KEY.startsWith("<") ? env.MCP_ACCESS_KEY : null;
  return {
    envFile: ENV_FILE,
    functionsUrl: base,
    accessKey: key,
    ready: Boolean(base && key),
    exportDir: env.EXPORT_DIR ? path.resolve(env.EXPORT_DIR) : path.join(os.homedir(), "open-brain-export"),
    coreHook: isOn(env.CORE_HOOK, true),
    sessionLogs: isOn(env.SESSION_LOGS, true),
    sessionLogUpload: isOn(env.SESSION_LOG_UPLOAD, false), // OFF unless explicitly turned on
    sessionLogProject: env.SESSION_LOG_PROJECT || "",
    sessionLogDir: path.join(os.homedir(), "claude-session-logs"),
    fridaySuggestion: isOn(env.FRIDAY_SUGGESTION, true),
  };
}

module.exports = { getConfig, parseEnv, isOn, checkUrl, ENV_FILE };
