// ─────────────────────────────────────────────────────────────
// isServiceCaller: is this request from your own scheduler / functions
// (the master "service role" key), or from someone else?
//
// Used by weekly-digest, daily-quiz, gap-questions and weekly-condenser.
// The old copy in each of those files only READ the "role" written inside the
// token and never checked its signature, so anyone could make up a token that
// says "service_role" and get in (DECISIONS.md, 2026-11-03).
//
// Now a token counts as the service role only if:
//   1. it is exactly the SUPABASE_SERVICE_ROLE_KEY this function was given, or
//   2. it says "service_role" AND Supabase's own login service (Auth) accepts it
//      for an admin-only request. Auth checks the signature with the project's
//      real signing secret, which this code never sees. A made-up token fails.
// Step 2 is there so a scheduled job keeps working even if the token it sends
// (for example one stored in Vault) is a genuine service-role token that is not
// character-for-character the same as SUPABASE_SERVICE_ROLE_KEY.
// Anything else (no token, a user's login token, a made-up token) is NOT the
// service role, and the function treats it as an app user or refuses it.
// ─────────────────────────────────────────────────────────────

/** The token after "Bearer ", or "" if there is none. */
export function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

/** Reads the middle part of a JWT without trusting it. null if it isn't one. */
function unverifiedClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims = JSON.parse(atob(b64));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/** Compares two strings without stopping at the first different character. */
function sameText(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Asks Supabase Auth whether this token is a genuine admin (service role) token. */
async function authAcceptsAsAdmin(token: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !anonKey) return false;
  try {
    // An admin-only, read-only request. Only a correctly signed service-role
    // token gets a 200; the list it returns is thrown away unread.
    const res = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
      method: "GET",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 200;
  } catch {
    return false; // network trouble or timeout: not proven, so not let in
  }
}

export async function isServiceCaller(req: Request): Promise<boolean> {
  const token = bearerToken(req);
  if (!token) return false;
  if (sameText(token, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")) return true;
  // Only tokens that at least claim to be the service role are worth asking Auth
  // about. App users' login tokens say "authenticated" and stop here.
  if (unverifiedClaims(token)?.role !== "service_role") return false;
  return await authAcceptsAsAdmin(token);
}
