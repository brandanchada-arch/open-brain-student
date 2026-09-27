// ============================================================================
// SEARCH-BRAIN
// ============================================================================
// The app's Search tab calls this. It runs the same hybrid search
// (meaning + keywords + chunks) that Claude Desktop gets through the MCP server.
//
// WHY THIS RUNS ON THE SERVER: searching by meaning needs an embedding of the
// search phrase, and making one needs the OpenRouter key. That key can never
// sit inside a web page, so the browser asks this function to do it.
//
// WHO IS SEARCHING comes from the caller's own login token — never from the
// request body, where a browser could put any user id it likes.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// Long captures can be 100,000+ characters. The app only shows the start of
// each one, so don't send the whole thing over the network.
const MAX_CONTENT_CHARS = 3000;

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

// Ask generate-embedding for the query's embedding.
// Returns null on any failure, so search falls back to keywords only.
async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.embedding)) {
      console.error(`generate-embedding returned ${res.status}:`, data?.error ?? data);
      return null;
    }
    return data.embedding;
  } catch (err) {
    console.error("generate-embedding call failed:", err);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Use POST" }, 405);
  }

  try {
    // Who is asking? Taken from their login token, never from the request body.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ ok: false, error: "Not signed in" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) {
      return jsonResponse({ ok: false, error: "A query is required" }, 400);
    }
    const requested = Number(body?.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;

    // A failed embedding is not an error: search just runs keyword-only.
    const queryEmbedding = await generateEmbedding(query);

    // The service role is needed here because thought_chunks has no RLS
    // policies at all (on purpose). That is exactly why p_user_id must be
    // the caller's own id from their token.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { data, error } = await admin.rpc("search_thoughts", {
      query_text: query,
      p_user_id: user.id,
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: limit,
    });
    if (error) throw error;

    const results = (data ?? []).slice(0, limit).map((r: any) => ({
      id: r.id,
      content: String(r.content ?? "").slice(0, MAX_CONTENT_CHARS),
      content_length: String(r.content ?? "").length,
      created_at: r.created_at,
      similarity: r.similarity,
      matched_chunk: r.matched_chunk,
      match_source: r.match_source,
    }));

    return jsonResponse({
      ok: true,
      mode: queryEmbedding ? "hybrid" : "keyword",
      results,
    });
  } catch (err) {
    console.error("search-brain failed:", err);
    return jsonResponse({ ok: false, error: "Search failed. See function logs." }, 500);
  }
});
