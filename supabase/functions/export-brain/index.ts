// ─────────────────────────────────────────────────────────────
// export-brain: lets the PC's weekly export script download a copy of the
// brain WITHOUT keeping the all-powerful service role key on the PC.
// The PC only holds MCP_ACCESS_KEY, and this function can only READ.
//
// Deploy (from the repo folder) with:
//   npx supabase functions deploy export-brain --no-verify-jwt --project-ref <project-ref>
// --no-verify-jwt because it checks MCP_ACCESS_KEY itself, like open-brain-mcp.
// Uses the secrets MCP_ACCESS_KEY and OWNER_USER_ID, which already exist.
// The real work is in handler.ts.
// ─────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleExport } from "./handler.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve((req) =>
  handleExport(req, {
    db,
    accessKey: Deno.env.get("MCP_ACCESS_KEY") ?? null,
    ownerId: Deno.env.get("OWNER_USER_ID") ?? null,
  })
);
