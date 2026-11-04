// Test helpers: a throwaway home folder (outside any git repo) with a .env pointing at the fake server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

export function tempHome(envLines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ob-home-"));
  fs.mkdirSync(path.join(home, ".open-brain"));
  fs.writeFileSync(path.join(home, ".open-brain", ".env"), envLines.join("\n"));
  return home;
}

// Run a script with HOME/USERPROFILE pointing at the temp home. Resolves {code, stdout, stderr, ms}.
export function runScript(script, args, { home, input, env = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const cleanEnv = { ...process.env };
    delete cleanEnv.OPEN_BRAIN_SESSION_LOG_CHILD;
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
      env: { ...cleanEnv, HOME: home, USERPROFILE: home, OneDrive: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { child.kill(); reject(new Error(`${script} timed out`)); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
