// open-brain-mcp: an MCP (Model Context Protocol) server exposing your
// "brain" (the Supabase `thoughts` table) to any MCP-compatible AI client,
// plus the Reference Library (`library`: class notes, transcripts, digests).
//
// It speaks JSON-RPC 2.0 over HTTP, which is what MCP uses under the hood.

import { createClient } from "npm:@supabase/supabase-js@2";
import { inBackground, indexLibraryEntry, pickQuizMaterial } from "../_shared/library.ts";
import { doorCheckViaGateway } from "../_shared/door-check.ts";
import {
  ADD_THOUGHT_DESCRIPTION, LibraryInputError, MAX_CONTENT_CHARS, SAVE_DOC_TYPES, SAVE_TO_LIBRARY_DESCRIPTION, saveToLibrary,
} from "../_shared/library-mcp.ts";
import {
  ADD_SESSION_LOG_DESCRIPTION, addDoorFlags, addSessionLog, GET_CORE_DESCRIPTION, GET_PAGE_DESCRIPTION, getCoreText, getPageText, labelRecent, MCP_INSTRUCTIONS,
  RECENT_SESSIONS_DESCRIPTION, recentSessions,
} from "../_shared/core-memory.ts";

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
// Level 8: whose thoughts search is allowed to return. Same UID the
// Telegram bot uses (Level 3).
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? null;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// How many linked thoughts to show under each search result,
// and how much of each one to preview.
const MAX_CONNECTED = 5;
const PREVIEW_CHARS = 200;
// Reference Library: get_library_entry returns long entries in pages this big.
const LIBRARY_PAGE_CHARS = 6000;

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
  // ---- Core memory (2026-11-03): listed first so clients see it first ----
  {
    name: "get_core",
    description: GET_CORE_DESCRIPTION,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_page",
    description: GET_PAGE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", enum: ["job-search", "courses", "mega", "core"], description: "Which page to read" },
      },
      required: ["slug"],
    },
  },
  {
    name: "add_session_log",
    description: ADD_SESSION_LOG_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A few words naming the session" },
        summary: { type: "string", description: "Short summary (max 2,000 characters): what was done, decisions, next steps" },
        project: { type: "string", description: "Optional project name, e.g. open-brain" },
        about_me: {
          type: "array",
          items: { type: "string" },
          description: "Optional: up to 3 short lasting things the user's own words showed about them",
        },
        session_key: { type: "string", description: "Optional: the session's id, so saving again updates its one summary" },
        session_at: { type: "string", description: "Optional: when the work happened, as an ISO date" },
      },
      required: ["title", "summary"],
    },
  },
  {
    name: "brain_health",
    description:
      "Check whether Open Brain is healthy: scheduled jobs that stopped, missing embeddings, new " +
      "notes without tags, an overdue PC backup (problems), plus counts of flagged library entries, " +
      "stale notes and proposals waiting (info). Counts and dates only, never note text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recent_sessions",
    description: RECENT_SESSIONS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many sessions (default 5, max 20)" } },
    },
  },
  {
    name: "search_thoughts",
    description:
      "Search stored thoughts by MEANING and by EXACT KEYWORDS at the same time (hybrid " +
      "search). Finds related ideas even when they use different words than the query, and " +
      "also finds exact names, numbers, and phrases. Long captures are searched paragraph " +
      "by paragraph: when a result has 'matched_passage', that is the part of a longer " +
      "capture that matched — quote it to the user. Each result includes a similarity score " +
      "from 0 to 1 (higher = closer in meaning), plus a 'connected' list: other thoughts " +
      "linked to it in the thought graph. Use the connected thoughts to surface related " +
      "ideas the user may have forgotten about. This searches only the user's OWN thoughts: " +
      "class notes, transcripts, articles and weekly digests live in the Reference Library " +
      "(use search_library). A result with 'from_library' is a takeaway from that library entry.",
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
    description: ADD_THOUGHT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text of the thought to save" },
      },
      required: ["content"],
    },
  },
  // ---- Reference Library (2026-10-22): class notes, transcripts, articles, digests ----
  {
    name: "save_to_library",
    description: SAVE_TO_LIBRARY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The page title (max 200 characters)" },
        content: {
          type: "string",
          description: `The readable text of the page (max ${MAX_CONTENT_CHARS.toLocaleString("en-US")} characters)`,
        },
        source_url: { type: "string", description: "The page address (http or https)" },
        doc_type: { type: "string", enum: SAVE_DOC_TYPES, description: "Optional, default article" },
        course: { type: "string", description: "Optional course code, e.g. BUS-485" },
        topic: { type: "string", description: "Optional topic" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      required: ["title", "content", "source_url"],
    },
  },
  {
    name: "search_library",
    description:
      "Search the user's REFERENCE LIBRARY (class notes, lecture/video transcripts, articles, " +
      "simulation data, weekly digests), NOT their own thoughts. Hybrid search by meaning and " +
      "exact keywords. Optional filters: course (e.g. BUS-485, FIN-451, ECN-460), doc_type " +
      "(class-notes, transcript, digest, reference, sim-data, personal-doc, article) and topic " +
      "(matches part of the topic). Use list_library first if you don't know the course or topic " +
      "names. With only filters and no query, it lists the newest matching entries. Results show " +
      "the passage that matched; use get_library_entry with the id to read the whole entry.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in plain language (can be empty when filters are given)" },
        course: { type: "string", description: "Optional course code, e.g. BUS-485" },
        doc_type: { type: "string", description: "Optional: class-notes, transcript, digest, reference, sim-data, personal-doc, article" },
        topic: { type: "string", description: "Optional topic (partial match)" },
        limit: { type: "number", description: "How many results (default 10, max 25)" },
      },
    },
  },
  {
    name: "list_library",
    description:
      "Show what is in the Reference Library. Without a course: counts by course, by doc_type " +
      "and by topic. With a course (and optionally doc_type or topic): the list of entries " +
      "(id, title, type, topic, date), no full text.",
    inputSchema: {
      type: "object",
      properties: {
        course: { type: "string", description: "Optional course code, e.g. BUS-485" },
        doc_type: { type: "string", description: "Optional doc_type filter" },
        topic: { type: "string", description: "Optional topic filter (partial match)" },
      },
    },
  },
  {
    name: "get_library_entry",
    description:
      `Read one Reference Library entry by id, in pages of about ${LIBRARY_PAGE_CHARS.toLocaleString()} ` +
      "characters. The reply says how many pages there are; ask for the next page to keep reading.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The library entry id (from search_library or list_library)" },
        page: { type: "number", description: "Page number, starting at 1 (default 1)" },
      },
      required: ["id"],
    },
  },
  {
    name: "library_quiz_material",
    description:
      "Random notes from the Reference Library for a course and/or topic, sized for you to quiz " +
      "the user. Write questions that test understanding or application (small scenarios or " +
      "calculations), ask ONE at a time, wait for the answer, then give feedback using only these " +
      "notes. Call again for fresh material.",
    inputSchema: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course code, e.g. BUS-485" },
        topic: { type: "string", description: "Optional topic (partial match)" },
        count: { type: "number", description: "How many notes (default 5, max 10)" },
      },
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

// Level 8: a whole YouTube transcript can be 100,000+ characters. Sending
// that back in every search floods the AI reading the results, so long
// thoughts are cut off here. Their chunks carry the detail instead.
const MAX_RESULT_CHARS = 3000;
function truncateLong(text: string) {
  const s = String(text ?? "");
  return s.length > MAX_RESULT_CHARS
    ? s.slice(0, MAX_RESULT_CHARS) + `… [truncated — ${s.length.toLocaleString()} characters total]`
    : s;
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
      .in("id", [...otherIds])
      .is("archived_at", null); // moved-to-library thoughts never show as connections
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

// Reference Library: thoughts that are takeaways from a library entry get a
// "from_library" line, e.g. "From library: Week 3 notes (<id>)". Never breaks search.
async function attachLibraryLinks(results: any[]) {
  if (results.length === 0) return results;
  try {
    const { data: links, error } = await supabase
      .from("library_links")
      .select("thought_id, library_id")
      .in("thought_id", results.map((r) => r.id));
    if (error) throw error;
    if (!links?.length) return results;

    const { data: entries, error: entriesError } = await supabase
      .from("library")
      .select("id, title")
      .in("id", [...new Set(links.map((l: any) => l.library_id))]);
    if (entriesError) throw entriesError;
    const titles = new Map((entries ?? []).map((e: any) => [e.id, e.title]));

    return results.map((r) => {
      const mine = links.filter((l: any) => l.thought_id === r.id && titles.has(l.library_id));
      if (!mine.length) return r;
      return {
        ...r,
        from_library: mine.map((l: any) => `From library: ${titles.get(l.library_id)} (${l.library_id})`).join("; "),
      };
    });
  } catch (err) {
    console.error("Looking up library links failed:", err);
    return results;
  }
}

function textResult(id: number | string | null, value: unknown) {
  return new Response(
    JSON.stringify(rpcResult(id, {
      content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    })),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// A mistake in the tool arguments: shown to the AI as a normal tool error it can fix and retry.
function toolError(id: number | string | null, message: string) {
  return new Response(
    JSON.stringify(rpcResult(id, { content: [{ type: "text", text: message }], isError: true })),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

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
  // (Claude Desktop, Claude Code, and the claude.ai/phone connector all send this header)
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
          serverInfo: { name: "open-brain-mcp", version: "1.6.0" },
          // Clients that support it add this to Claude's context. Not all do,
          // so get_core's description says the same thing.
          instructions: MCP_INSTRUCTIONS,
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

      // ---------------- Core memory tools ----------------
      // Service role again, so both are filtered to OWNER_USER_ID.
      if (toolName === "get_core" || toolName === "add_session_log" || toolName === "recent_sessions") {
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }
        if (toolName === "get_core") return textResult(id, await getCoreText(supabase, OWNER_USER_ID));
        if (toolName === "recent_sessions") return textResult(id, await recentSessions(supabase, OWNER_USER_ID, args));
        return textResult(id, await addSessionLog(supabase, OWNER_USER_ID, args));
      }

      if (toolName === "get_page") {
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }
        return textResult(id, await getPageText(supabase, OWNER_USER_ID, args.slug));
      }

      if (toolName === "brain_health") {
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }
        const { data, error } = await supabase.rpc("brain_health", { p_user: OWNER_USER_ID });
        if (error) throw new Error(`Could not read brain health: ${error.message}`);
        return textResult(id, data);
      }

      if (toolName === "search_thoughts") {
        const query = String(args.query ?? "").trim();

        // Level 8: this function uses the service role key, so row-level
        // security is NOT filtering for us. search_thoughts must be told
        // whose thoughts to search. No owner configured = refuse to search,
        // rather than risk searching everyone's thoughts.
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }

        // Level 8: hybrid search. Send the raw text (for keyword matching)
        // AND its embedding (for meaning). If the embedding fails, it is
        // left null and the database falls back to keyword-only on its own.
        const queryEmbedding = query ? await generateEmbedding(query) : null;

        const { data, error } = await supabase.rpc("search_thoughts", {
          query_text: query,
          p_user_id: OWNER_USER_ID,
          query_embedding: queryEmbedding,
          match_threshold: 0.3,
          match_count: 10,
        });
        if (error) throw error;

        const mode = queryEmbedding
          ? "hybrid (meaning + keywords)"
          : "keyword only (fallback: embeddings unavailable)";

        let results: any[] = (data ?? []).map((r: any) => ({
          id: r.id,
          // When the match came from inside a long capture, show the
          // paragraph that matched instead of the start of the document.
          ...(r.matched_chunk
            ? {
                matched_passage: r.matched_chunk,
                note: "(from partway through a longer capture)",
                content_start: preview(r.content),
              }
            : { content: truncateLong(r.content) }),
          created_at: r.created_at,
          similarity: Math.round(r.similarity * 100) / 100,
          match_source: r.match_source,
        }));

        // Level 6: add each result's graph neighbors
        results = await attachConnections(results);
        // Reference Library: say which library entry a takeaway came from
        results = await attachLibraryLinks(results);

        return new Response(
          JSON.stringify(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify({ mode, results }, null, 2) }],
          })),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (toolName === "list_recent") {
        // Same rule as search_thoughts: the service role skips row-level
        // security, so filter to the owner ourselves, and refuse if unset.
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }

        const limit = args.limit ?? 10;
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, created_at, outdated_at")
          .eq("user_id", OWNER_USER_ID)
          .is("archived_at", null) // moved-to-library thoughts are hidden
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) throw error;

        return new Response(
          JSON.stringify(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(labelRecent(data ?? []), null, 2) }],
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

      // ---------------- Reference Library tools ----------------
      // All of them use the service role, so every query is filtered to OWNER_USER_ID.
      if (toolName === "save_to_library") {
        // The owner always comes from the OWNER_USER_ID secret, never from the arguments.
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }
        const owner = OWNER_USER_ID;
        try {
          return textResult(id, await saveToLibrary(supabase, owner, args, {
            doorCheck: (text) => doorCheckViaGateway(text, owner, "open-brain-mcp"),
            // Long pages take a while to embed, so that carries on after the reply (as in save-library).
            index: (libraryId, content) => inBackground(indexLibraryEntry(supabase, libraryId, content, "save_to_library")),
          }));
        } catch (err) {
          if (err instanceof LibraryInputError) return toolError(id, `save_to_library: ${err.message}`);
          throw err;
        }
      }

      if (["search_library", "list_library", "get_library_entry", "library_quiz_material"].includes(toolName)) {
        if (!OWNER_USER_ID) {
          throw new Error("OWNER_USER_ID is not set in Edge Function secrets");
        }
      }

      if (toolName === "search_library") {
        const query = String(args.query ?? "").trim();
        const course = optStr(args.course), docType = optStr(args.doc_type), topic = optStr(args.topic);
        if (!query && !course && !docType && !topic) {
          throw new Error("Give a query, or at least one filter (course, doc_type, topic)");
        }
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
        const queryEmbedding = query ? await generateEmbedding(query) : null;
        const { data, error } = await supabase.rpc("search_library", {
          query_text: query,
          p_user_id: OWNER_USER_ID,
          query_embedding: queryEmbedding,
          match_threshold: 0.3,
          match_count: limit,
          p_course: course,
          p_doc_type: docType,
          p_topic: topic,
        });
        if (error) throw error;
        const results = (data ?? []).map((r: any) => ({
          id: r.id,
          title: r.title,
          doc_type: r.doc_type,
          course: r.course,
          topic: r.topic,
          created_at: r.created_at,
          ...(r.matched_chunk
            ? { matched_passage: r.matched_chunk, content_start: preview(r.content) }
            : { content: truncateLong(r.content) }),
          similarity: Math.round(r.similarity * 100) / 100,
          content_length: String(r.content ?? "").length,
        }));
        const mode = !query ? "filters only (newest first)"
          : queryEmbedding ? "hybrid (meaning + keywords)" : "keyword only (fallback: embeddings unavailable)";
        return textResult(id, { mode, results: await addDoorFlags(supabase, OWNER_USER_ID ?? "", results) });
      }

      if (toolName === "list_library") {
        const course = optStr(args.course), docType = optStr(args.doc_type), topic = optStr(args.topic);
        let q = supabase.from("library")
          .select("id, title, doc_type, course, topic, created_at")
          .eq("user_id", OWNER_USER_ID)
          .order("created_at", { ascending: false })
          .limit(1000);
        if (course) q = q.ilike("course", course);
        if (docType) q = q.ilike("doc_type", docType);
        if (topic) q = q.ilike("topic", `%${topic}%`);
        const { data, error } = await q;
        if (error) throw error;
        const rows = data ?? [];
        if (course || docType || topic) {
          return textResult(id, { total: rows.length, entries: rows });
        }
        const countBy = (key: string) => {
          const m: Record<string, number> = {};
          for (const r of rows as any[]) {
            const k = r[key] ?? "(none)";
            m[k] = (m[k] ?? 0) + 1;
          }
          return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
        };
        return textResult(id, {
          total: rows.length,
          by_course: countBy("course"),
          by_doc_type: countBy("doc_type"),
          by_topic: countBy("topic"),
          tip: "Call list_library with a course to see its entries, or search_library to search.",
        });
      }

      if (toolName === "get_library_entry") {
        const entryId = String(args.id ?? "").trim();
        if (!/^[0-9a-f-]{36}$/i.test(entryId)) throw new Error("id must be a library entry id (a uuid)");
        const { data: entry, error } = await supabase
          .from("library")
          .select("id, title, content, doc_type, course, topic, tags, summary, source_url, created_at")
          .eq("id", entryId)
          .eq("user_id", OWNER_USER_ID)
          .maybeSingle();
        if (error) throw error;
        if (!entry) throw new Error(`No library entry with id ${entryId}`);
        const content = String(entry.content ?? "");
        const pages = Math.max(1, Math.ceil(content.length / LIBRARY_PAGE_CHARS));
        const page = Math.min(Math.max(Math.floor(Number(args.page) || 1), 1), pages);
        const { content: _all, ...info } = entry;
        return textResult(id, {
          ...info,
          page,
          pages,
          total_characters: content.length,
          content: content.slice((page - 1) * LIBRARY_PAGE_CHARS, page * LIBRARY_PAGE_CHARS),
          ...(page < pages ? { next: `Call get_library_entry with page ${page + 1} to keep reading.` } : {}),
        });
      }

      if (toolName === "library_quiz_material") {
        const course = optStr(args.course), topic = optStr(args.topic);
        const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
        const notes = await pickQuizMaterial(supabase, OWNER_USER_ID!, {
          course, topic, maxNotes: count, perNoteChars: 2500, totalChars: 12000,
        });
        if (notes.length === 0) {
          return textResult(id, {
            notes: [],
            note: `No library notes for ${[course, topic].filter(Boolean).join(" / ") || "that"}. Try list_library to see course and topic names.`,
          });
        }
        return textResult(id, {
          how_to_quiz: "Ask one question at a time, wait for the answer, then give feedback from these notes only.",
          notes: notes.map((n) => ({ id: n.id, title: n.title, course: n.course, topic: n.topic, doc_type: n.doc_type, text: n.text })),
        });
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