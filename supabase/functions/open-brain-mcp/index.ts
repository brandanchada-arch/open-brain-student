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

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
    description: "Search stored thoughts by keyword and return matching results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for" },
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
    // Every MCP client starts a connection by calling "initialize" first.
    // We reply with our protocol version and basic server info so the
    // client knows it's talking to a real MCP server.
    if (method === "initialize") {
      return new Response(
        JSON.stringify(rpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "open-brain-mcp", version: "1.0.0" },
        })),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // --- notifications/initialized: client confirming handshake is done ---
    // This is a notification (no response expected), so we just acknowledge it.
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
        const query = args.query ?? "";
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, created_at")
          .ilike("content", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(10);

        if (error) throw error;

        return new Response(
          JSON.stringify(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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
          .insert({ content })
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