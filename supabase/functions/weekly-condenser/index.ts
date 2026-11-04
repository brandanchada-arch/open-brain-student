// ─────────────────────────────────────────────────────────────
// weekly-condenser: every Sunday (pg_cron, an hour after weekly-digest) it
// reads the week's new notes and PROPOSES updates to your brain pages
// (core, job-search, courses, mega). You approve or reject them in the app
// (Brain → Review). It never changes a page itself.
//
// Every AI call goes through call-llm. This file never talks to an
// AI company directly. The real work is in handler.ts.
// ─────────────────────────────────────────────────────────────

import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonrepair } from "npm:jsonrepair@3";
import { runCondenser } from "./handler.ts";
import { isServiceCaller } from "../_shared/service-caller.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Whose brain this is (same secret the MCP server and Telegram bot use).
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? null;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


async function callLlm(systemPrompt: string, prompt: string, maxTokens: number) {
  // With the header, or call-llm says 401
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      systemPrompt,
      prompt,
      maxTokens,
      userId: OWNER_USER_ID ?? undefined,
      source: "weekly-condenser",
    }),
  });
  const llm = await res.json().catch(() => ({}));
  if (!res.ok || !llm.text) {
    throw new Error(`call-llm returned ${res.status}: ${JSON.stringify(llm)}`);
  }
  return String(llm.text);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  // Only your own scheduler and functions may run this.
  if (!(await isServiceCaller(req))) return reply({ error: "Unauthorized" }, 401);
  if (!OWNER_USER_ID) return reply({ error: "OWNER_USER_ID is not set in Edge Function secrets" }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const result = await runCondenser({ db: admin, ownerId: OWNER_USER_ID, callLlm, repair: jsonrepair });
    console.log("weekly-condenser:", JSON.stringify(result));
    return reply(result);
  } catch (err) {
    console.error("weekly-condenser failed:", err);
    return reply({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
