// open-brain-mcp: an MCP (Model Context Protocol) server exposing your
// "brain" (the Supabase `thoughts` table) to any MCP-compatible AI client.
//
// It speaks JSON-RPC 2.0 over HTTP, which is what MCP uses under the hood.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// These come from Supabase automatically — no setup needed.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into every
// edge function's environment by Supabase itself.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// This one you created yourself in Step 2 — it's the password that
// keeps random people on the internet from calling your brain.
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
// Whose brain this is. Every thought saved through MCP gets stamped with it.
const BRAIN_OWNER_ID = Deno.env.get("BRAIN_OWNER_ID") ?? null;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// How many linked thoughts to show under each search result,
// and how much of each one to preview.
const MAX_CONNECTED = 5;
const PREVIEW_CHARS = 200;

// Standard CORS headers so browsers/tools calling this from elsewhere don't get blocked.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The list of tools this MCP server offers. This is what gets returned
// when a client calls "tools/list" — it's basically the menu of things
// the AI is allowed to do with your brain.
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search stored thoughts by MEANING (semantic search). Finds related ideas even when " +
      "they use different words than the query. Each result includes a similarity score " +
      "from 0 to 1 (higher = closer in meaning), plus a 'connected' list: other thoughts " +
      "linked to it in the thought graph. Use the connected thoughts to surface related " +
      "ideas the user may have forgotten about.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're looking for, in plain language" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recently saved thoughts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent thoughts to return (default 10)" },
      },
    },
  },
  {
    name: "add_thought",
    description: "Save a new thought to the brain.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text of the thought to save" },
      },
      required: ["content"],
    },
  },
];

// Helper to build a JSON-RPC 2.0 success response.
function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// Helper to build a JSON-RPC 2.0 error response.
function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Level 6: turn text into an embedding by calling generate-embedding.
// Returns null on any failure, so search can fall back to keywords.
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

function preview(text: string) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > PREVIEW_CHARS ? clean.slice(0, PREVIEW_CHARS) + "…" : clean;
}

// Level 6: for each search result, look up its links in the thought graph
// (in either direction) and attach short previews of the connected thoughts.
// If anything goes wrong, results come back unchanged — search never breaks.
async function attachConnections(results: any[]) {
  if (results.length === 0) return results;

  try {
    const ids = results.map((r) => r.id);
    const idList = ids.join(",");

    const { data: links, error } = await supabase
      .from("thought_links")
      .select("source_thought_id, target_thought_id, similarity_score")
      .or(`source_thought_id.in.(${idList}),target_thought_id.in.(${idList})`);
    if (error) throw error;

    // For each result, collect the thought on the OTHER end of each link
    const neighbors = new Map<string, { id: string; score: number }[]>();
    const otherIds = new Set<string>();

    for (const link of links ?? []) {
      for (const [self, other] of [
        [link.source_thought_id, link.target_thought_id],
        [link.target_thought_id, link.source_thought_id],
      ]) {
        if (!ids.includes(self)) continue;
        if (!neighbors.has(self)) neighbors.set(self, []);
        neighbors.get(self)!.push({ id: other, score: link.similarity_score });
        otherIds.add(other);
      }
    }

    if (otherIds.size === 0) {
      return results.map((r) => ({ ...r, connected: [] }));
    }

    const { data: others, error: othersError } = await supabase
      .from("thoughts")
      .select("id, content, created_at")
      .in("id", [...otherIds]);
    if (othersError) throw othersError;

    const byId = new Map((others ?? []).map((t: any) => [t.id, t]));

    return results.map((r) => ({
      ...r,
      connected: (neighbors.get(r.id) ?? [])
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CONNECTED)
        .filter((n) => byId.has(n.id))
        .map((n) => ({
          id: n.id,
          link_similarity: Math.round(n.score * 100) / 100,
          created_at: byId.get(n.id).created_at,
          preview: preview(byId.get(n.id).content),
        })),
    }));
  } catch (err) {
    console.error("Looking up graph connections failed:", err);
    return results;
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // --- Auth check ---
  // We expect: Authorization: Bearer <MCP_ACCESS_KEY>
  const authHeader = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${MCP_ACCESS_KEY}`;
  if (authHeader !== expected) {
    return new Response(
      JSON.stringify(rpcError(null, -32001, "Unauthorized: invalid or missing access key")),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // --- Parse the JSON-RPC request ---
  let body: { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32700, "Parse error: invalid JSON")),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { id = null, method, params = {} } = body;

  try {
    // --- initialize: the required MCP handshake ---
    if (method === "initialize") {
      return new Response(
        JSON.stringify(rpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "open-brain-mcp", version: "1.2.0" },
        })),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // --- notifications/initialized: client confirming handshake is done ---
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202, headers: corsHeaders });
    }

    // --- tools/list: tell the client what tools are available ---
    if (method === "tools/list") {
      return new Response(
        JSON.stringify(rpcResult(id, { tools: TOOLS })),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // --- tools/call: actually run one of the tools ---
    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "search_thoughts") {
        const query = String(args.query ?? "").trim();

        // Level 6: semantic search. Turn the query into an embedding,
        // then ask the database for the thoughts closest in meaning.
        const queryEmbedding = query ? await generateEmbedding(query) : null;

        let results: any[];
        let mode: string;

        if (queryEmbedding) {
          const { data, error } = await supabase.rpc("search_thoughts", {
            query_embedding: queryEmbedding,
            match_threshold: 0.3,
            match_count: 10,
          });
          if (error) throw error;

          mode = "semantic";
          results = (data ?? []).map((r: any) => ({
            id: r.id,
            content: r.content,
            created_at: r.created_at,
            similarity: Math.round(r.similarity * 100) / 100,
          }));
        } else {
          // Safety net: if embeddings are unavailable, fall back to
          // plain keyword matching so search never breaks entirely.
          const { data, error } = await supabase
            .from("thoughts")
            .select("id, content, created_at")
            .ilike("content", `%${query}%`)
            .order("created_at", { ascending: false })
            .limit(10);
          if (error) throw error;

          mode = "keyword (fallback: embeddings unavailable)";
          results = data ?? [];
        }

        // Level 6: add each result's graph neighbors
        results = await attachConnections(results);

        return new Response(
          JSON.stringify(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify({ mode, results }, null, 2) }],
          })),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (toolName === "list_recent") {
        const limit = args.limit ?? 10;
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) throw error;

        return new Response(
          JSON.stringify(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          })),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (toolName === "add_thought") {
        const content = args.content ?? "";
        const { data, error } = await supabase
          .from("thoughts")
          .upsert(
            { content, user_id: BRAIN_OWNER_ID },
            { onConflict: "dedup_key,user_id", ignoreDuplicates: false }
          )
          .select()
          .single();

        if (error) throw error;

        return new Response(
          JSON.stringify(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          })),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify(rpcError(id, -32602, `Unknown tool: ${toolName}`)),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Any other method we don't recognize.
    return new Response(
      JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`)),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify(rpcError(id, -32000, `Server error: ${(err as Error).message}`)),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});