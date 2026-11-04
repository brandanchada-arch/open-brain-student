// export-brain: the logic. index.ts only wires it to Supabase.
// Kept free of remote imports so it can be tested on any computer with Node:
//   node --experimental-strip-types pc-setup/tests/export-brain.test.mjs
//
// What it does: hands back the owner's rows, a small page at a time, so the PC's
// weekly export script can save a copy. READ-ONLY: it only ever runs SELECTs.
//
// Request:  POST  Authorization: Bearer <MCP_ACCESS_KEY>
//   { "table": "thoughts" | "library" | "thought_links",
//     "include_archived": false,   // thoughts only; true = also archived ones (for the backup)
//     "after": "<id>",             // cursor from the previous page's next_after; omit for page 1
//     "limit": 25 }                // rows per page, 1–50 (default 25)
// Response: { table, rows, count, next_after, done }
//   Keep calling with after = next_after until done is true.

// deno-lint-ignore no-explicit-any
type Db = any;

export type ExportDeps = {
  db: Db;                    // supabase-js client using the service role
  accessKey: string | null;  // MCP_ACCESS_KEY secret
  ownerId: string | null;    // OWNER_USER_ID secret
};

export const TABLES = ["thoughts", "library", "thought_links"] as const;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
// Some thoughts are 100,000+ characters. A page stops early once its text passes
// this many characters (always at least one row), so a reply stays a few MB at most
// and every call finishes far inside the ~150 s function time limit.
export const MAX_PAGE_CHARS = 1_500_000;

// Columns that are never sent: embeddings (big; the backfill jobs rebuild them),
// generated search columns, and the user id (always the owner anyway).
function cleanRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "embedding" || k.endsWith("_embedding") || k.endsWith("_tsv") || k === "user_id") continue;
    out[k] = v;
  }
  return out;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Compare without stopping at the first wrong character, so timing doesn't leak the key.
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleExport(req: Request, deps: ExportDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST" });

  // No key configured = nobody gets in (never "open by default").
  if (!deps.accessKey) return json(500, { error: "MCP_ACCESS_KEY is not set in Edge Function secrets" });
  const auth = req.headers.get("Authorization") ?? "";
  if (!sameSecret(auth, `Bearer ${deps.accessKey}`)) {
    return json(401, { error: "Unauthorized: invalid or missing access key" });
  }
  // The service role skips row-level security, so we filter by owner ourselves.
  if (!deps.ownerId) return json(500, { error: "OWNER_USER_ID is not set in Edge Function secrets" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body must be JSON" });
  }
  if (!body || typeof body !== "object") return json(400, { error: "Body must be a JSON object" });

  const table = String(body.table ?? "");
  if (!(TABLES as readonly string[]).includes(table)) {
    return json(400, { error: `table must be one of: ${TABLES.join(", ")}` });
  }
  const includeArchived = body.include_archived === true;
  const limit = Math.min(Math.max(Math.floor(Number(body.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const after = body.after == null || body.after === "" ? null : String(body.after);
  if (after !== null && !UUID.test(after)) return json(400, { error: "after must be an id from next_after" });

  try {
    // Pages are ordered by id, so "after" is a simple, stable cursor: rows added
    // during an export can't shift a page and make another row be skipped.
    let q = deps.db.from(table).select("*").eq("user_id", deps.ownerId);
    if (table === "thoughts" && !includeArchived) q = q.is("archived_at", null);
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message ?? String(error));

    const fetched: Record<string, unknown>[] = data ?? [];
    const rows: Record<string, unknown>[] = [];
    let chars = 0;
    for (const r of fetched) {
      const size = String(r.content ?? "").length + String(r.summary ?? "").length;
      if (rows.length > 0 && chars + size > MAX_PAGE_CHARS) break;
      rows.push(cleanRow(r));
      chars += size;
    }
    // Done only when the database had nothing more to give.
    const done = fetched.length < limit && rows.length === fetched.length;
    const last = rows.length ? String(rows[rows.length - 1].id) : after;
    return json(200, { table, rows, count: rows.length, next_after: done ? null : last, done });
  } catch (err) {
    console.error(`export-brain ${table} failed:`, err);
    return json(500, { error: `Export failed: ${(err as Error).message}` });
  }
}
