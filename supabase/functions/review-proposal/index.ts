// ─────────────────────────────────────────────────────────────
// review-proposal: the app's Brain → Review screen calls this to
// Approve or Reject a proposed page change, or Undo the last approved one.
//
// Deploy normally (WITH JWT verification, no --no-verify-jwt):
//   npx supabase functions deploy review-proposal --project-ref <project-ref>
//
// Who you are comes from your login token (anon client + auth.getUser()),
// never from the request body. The page changes are done by the database
// functions approve_brain_proposal / reject_brain_proposal /
// undo_brain_page_change with the service role, which only touch your rows.
// The real work is in handler.ts.
// ─────────────────────────────────────────────────────────────

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleReview } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function getUser(authHeader: string) {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return { id: user.id };
}

Deno.serve((req) => handleReview(req, { getUser, admin }));
