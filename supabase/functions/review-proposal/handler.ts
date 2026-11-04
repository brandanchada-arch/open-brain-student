// ─────────────────────────────────────────────────────────────
// review-proposal, the part that does the work. index.ts passes in the real
// "who is this?" check and the real service-role database, so the tests can
// pass fakes instead.
//
// POST { action: "approve" | "reject", id: "<proposal uuid>" }
//   or { action: "undo" }   (puts back the page from before the last approved change)
//
// The user ALWAYS comes from the login token. Anything like user_id in the
// body is ignored. The database functions only touch that user's rows.
// ─────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
export type ReviewDeps = {
  // Given the Authorization header, return the signed-in user (or null).
  getUser: (authHeader: string) => Promise<{ id: string } | null>;
  // Service-role supabase client (only .rpc is used).
  admin: any;
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Turn the database's error into a plain message and a fitting status code.
function sqlError(message: string) {
  if (/not found/i.test(message)) return json({ ok: false, error: "That proposal wasn't found." }, 404);
  if (/already/i.test(message)) return json({ ok: false, error: message }, 409);
  if (/nothing to undo/i.test(message)) return json({ ok: false, error: "Nothing to undo." }, 409);
  if (/too long/i.test(message)) return json({ ok: false, error: message }, 422);
  return json({ ok: false, error: "Could not save that. Try again." }, 500);
}

export async function handleReview(req: Request, deps: ReviewDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  // 1. Who is asking? From the login token, never from the body.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authHeader)) return json({ ok: false, error: "Not signed in" }, 401);
  let user: { id: string } | null = null;
  try {
    user = await deps.getUser(authHeader);
  } catch {
    user = null;
  }
  if (!user?.id || !UUID_RE.test(user.id)) return json({ ok: false, error: "Not signed in" }, 401);

  // 2. What do they want?
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Send JSON like {\"action\": \"approve\", \"id\": \"…\"}" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "Send JSON like {\"action\": \"approve\", \"id\": \"…\"}" }, 400);
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "undo") {
    return json({ ok: false, error: "action must be approve, reject or undo" }, 400);
  }

  // 3. Do it with the database function (each one is a single transaction).
  let rpcName: string;
  let args: Record<string, string>;
  if (action === "undo") {
    rpcName = "undo_brain_page_change";
    args = { p_user_id: user.id };
  } else {
    const id = body.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return json({ ok: false, error: "id must be a proposal id (uuid)" }, 400);
    }
    rpcName = action === "approve" ? "approve_brain_proposal" : "reject_brain_proposal";
    args = { p_user_id: user.id, p_proposal_id: id };
  }

  try {
    const { data, error } = await deps.admin.rpc(rpcName, args);
    if (error) return sqlError(String(error.message ?? error));
    return json({ ok: true, action, slug: data?.slug ?? null });
  } catch (err) {
    console.error("review-proposal failed:", err);
    return json({ ok: false, error: "Could not save that. Try again." }, 500);
  }
}
