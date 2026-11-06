// ============================================================================
// SAVE-LIBRARY
// ============================================================================
// The web app's PDF upload (and the "paste a transcript" box) saves here, into
// the Reference Library (table `library`) instead of the brain.
//
// WHY THIS RUNS ON THE SERVER: a library entry needs an embedding (and chunks
// when it is long) to be searchable by meaning, and making those needs the AI
// key, which can never sit in a web page.
//
// WHO IS SAVING comes from the caller's own login token, never from the body.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { firstLine, inBackground, indexLibraryEntry, saveLibraryEntry } from "../_shared/library.ts";
import { doorCheckViaGateway } from "../_shared/door-check.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAX_CHARS = 400_000; // a very long PDF; bigger ones should be split
const DOC_TYPES_FROM_APP = ["reference", "class-notes", "transcript", "article", "personal-doc", "sim-data"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Use POST" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return jsonResponse({ ok: false, error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return jsonResponse({ ok: false, error: "Nothing to save" }, 400);
    if (content.length > MAX_CHARS) {
      return jsonResponse({ ok: false, error: `Too long (${content.length.toLocaleString()} characters, max ${MAX_CHARS.toLocaleString()}). Split it into parts.` }, 413);
    }
    const docType = DOC_TYPES_FROM_APP.includes(body?.doc_type) ? body.doc_type : "reference";
    const course = str(body?.course, 20)?.toUpperCase() ?? null;
    const metadata = body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const title = str(body?.title) ?? firstLine(content);
    // Door check: flags text that tries to instruct an AI. Never blocks the save. Patterns run
    // over the whole text; only a small sample ever goes to the AI.
    const door_check = await doorCheckViaGateway(`${title}\n${content}`, user.id, "save-library");
    const saved = await saveLibraryEntry(admin, {
      user_id: user.id,
      title,
      content,
      doc_type: docType,
      course,
      topic: str(body?.topic),
      source_url: str(body?.source_url, 2000),
      metadata: { ...metadata, source: str(body?.source, 40) ?? "app", door_check }, // ours wins over any sent in the body
    });

    // Long PDFs can take a while to embed, so that work carries on after we answer.
    await inBackground(indexLibraryEntry(admin, saved.id, content, "save-library"));

    return jsonResponse({ ok: true, id: saved.id, updated: saved.updated, library: true, door_flagged: door_check.flagged });
  } catch (err) {
    console.error("save-library failed:", String(err));
    return jsonResponse({ ok: false, error: "Could not save to the library. See function logs." }, 500);
  }
});
