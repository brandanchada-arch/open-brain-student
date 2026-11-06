// ============================================================================
// EDIT-THOUGHT (2026-11-03)
// ============================================================================
// The app's "Edit" button calls this to change a thought's text and/or mark it
// outdated (optionally pointing to the note that replaces it).
//
// Body: { id, content?, outdated?: boolean, replaced_by?: uuid | null }
//
// 1. WHO is editing comes from the login token, never from the body.
// 2. save_thought_edit (SQL, one transaction) saves the old text to thought_versions,
//    then changes the row. If the new text is identical to another of your notes
//    (unique dedup_key), nothing changes and you get a 409 saying which note.
// 3. The embedding, links, chunks and tags are rebuilt with the same shared code
//    enrich-thought uses. Short notes are rebuilt before we answer; long ones in the
//    background. Anything that fails is left for the backfill jobs to repair.
// Thoughts are never deleted.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { inBackground } from "../_shared/library.ts";
import { rebuildThought } from "../_shared/thought-edit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAX_CHARS = 200_000;       // the biggest captures are ~100k
const INLINE_REBUILD_CHARS = 2000; // up to this, rebuild before answering
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Use POST" }, 405);

  try {
    // Who is editing? From their login token only.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return jsonResponse({ ok: false, error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === "string" && UUID.test(body.id) ? body.id : null;
    if (!id) return jsonResponse({ ok: false, error: "Which thought? (id missing)" }, 400);

    let content: string | null = null;
    if (body?.content !== undefined && body?.content !== null) {
      if (typeof body.content !== "string" || !body.content.trim()) {
        return jsonResponse({ ok: false, error: "A thought can't be empty." }, 400);
      }
      content = body.content.trim();
      if (content!.length > MAX_CHARS) {
        return jsonResponse({ ok: false, error: `Too long (max ${MAX_CHARS.toLocaleString()} characters).` }, 413);
      }
    }
    const outdated = typeof body?.outdated === "boolean" ? body.outdated : null;
    const replacedBy = typeof body?.replaced_by === "string" && UUID.test(body.replaced_by) ? body.replaced_by : null;
    if (content === null && outdated === null) {
      return jsonResponse({ ok: false, error: "Nothing to change." }, 400);
    }

    // Service role: save_thought_edit is not callable from the browser. It only touches
    // the row if it belongs to user.id and isn't archived.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: before } = await admin.from("thoughts").select("category")
      .eq("id", id).eq("user_id", user.id).is("archived_at", null).maybeSingle();

    const { data, error } = await admin.rpc("save_thought_edit", {
      p_thought_id: id,
      p_user_id: user.id,
      p_content: content,
      p_outdated: outdated,
      p_replaced_by: outdated === true ? replacedBy : null,
    });
    if (error) throw error;
    const r = Array.isArray(data) ? data[0] : data;

    if (r?.status === "not_found") return jsonResponse({ ok: false, error: "Thought not found." }, 404);
    if (r?.status === "bad_replacement") {
      return jsonResponse({ ok: false, error: "That replacement can't be used (it must be another of your own notes)." }, 400);
    }
    if (r?.status === "duplicate") {
      return jsonResponse({
        ok: false,
        error: r.duplicate_archived
          ? "Another note (now in your library archive) already has exactly this text. Nothing was changed."
          : "Another of your notes already has exactly this text. Nothing was changed.",
        duplicate_id: r.duplicate_archived ? null : r.duplicate_id,
      }, 409);
    }

    let rebuild: unknown = null;
    if (r?.content_changed && content) {
      const isOutdated = outdated === true || (outdated === null && await isMarkedOutdated(admin, id, user.id));
      const work = rebuildThought(admin, {
        id, userId: user.id, content, category: before?.category ?? null, outdated: isOutdated,
      });
      if (content.length <= INLINE_REBUILD_CHARS) rebuild = await work;
      else { await inBackground(work); rebuild = "background"; }
    }

    return jsonResponse({ ok: true, status: r?.status ?? "saved", content_changed: !!r?.content_changed, rebuild });
  } catch (err) {
    console.error("edit-thought failed:", err);
    return jsonResponse({ ok: false, error: "Could not save the edit. See function logs." }, 500);
  }
});

async function isMarkedOutdated(admin: any, id: string, userId: string): Promise<boolean> {
  const { data } = await admin.from("thoughts").select("outdated_at").eq("id", id).eq("user_id", userId).maybeSingle();
  return !!data?.outdated_at;
}
