// ─────────────────────────────────────────────────────────────
// weekly-news-filter: every Saturday morning (pg_cron) it lists 5 videos from
// public channel feeds, saves the list in the Library and queues one push.
// The real work is in handler.ts. The channel list lives in the database,
// never in this repo. Every AI call goes through call-llm.
// ─────────────────────────────────────────────────────────────

import { createClient } from "npm:@supabase/supabase-js@2";
import { jsonrepair } from "npm:jsonrepair@3";
import { runNewsFilter } from "./handler.ts";
import { indexLibraryEntry, type LibraryEntry, saveLibraryEntry } from "../_shared/library.ts";
import { isServiceCaller } from "../_shared/service-caller.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? null;

const MAX_FEED_CHARS = 2_000_000;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fetchFeed(channelId: string) {
  // Only a real channel id can reach the URL, whatever is in the table.
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) throw new Error("bad channel id");
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    headers: { "User-Agent": "OpenBrain-news-filter/1.0" }, // says what it is
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_FEED_CHARS) throw new Error("feed too large");
  return text;
}

async function callLlm(systemPrompt: string, prompt: string, maxTokens: number) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ systemPrompt, prompt, maxTokens, userId: OWNER_USER_ID ?? undefined, source: "weekly-news-filter" }),
  });
  const llm = await res.json().catch(() => ({}));
  if (!res.ok || !llm.text) throw new Error(`call-llm returned ${res.status}`);
  return String(llm.text);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  // Only your own scheduler and functions may run this.
  if (!(await isServiceCaller(req))) return reply({ error: "Unauthorized" }, 401);
  if (!OWNER_USER_ID) return reply({ error: "OWNER_USER_ID is not set in Edge Function secrets" }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const result = await runNewsFilter({
      db: admin,
      ownerId: OWNER_USER_ID,
      fetchFeed,
      callLlm,
      repair: jsonrepair,
      saveEntry: (entry) => saveLibraryEntry(admin, entry as unknown as LibraryEntry, { matchTitle: true }),
      indexEntry: (id, content) => indexLibraryEntry(admin, id, content, "weekly-news-filter"),
    });
    console.log("weekly-news-filter:", JSON.stringify(result));
    return reply(result);
  } catch (err) {
    console.error("weekly-news-filter failed:", err);
    return reply({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
