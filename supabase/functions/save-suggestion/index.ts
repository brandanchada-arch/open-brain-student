// save-suggestion: the PC's Friday script saves its one suggestion here. The work is in handler.ts.
// Deploy with --no-verify-jwt, because it checks MCP_ACCESS_KEY itself, like export-brain.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleSuggestion } from "./handler.ts";
import { indexLibraryEntry, type LibraryEntry, saveLibraryEntry } from "../_shared/library.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve((req) =>
  handleSuggestion(req, {
    db,
    accessKey: Deno.env.get("MCP_ACCESS_KEY") ?? null,
    ownerId: Deno.env.get("OWNER_USER_ID") ?? null,
    saveEntry: (entry) => saveLibraryEntry(db, entry as unknown as LibraryEntry, { matchTitle: true }),
    indexEntry: (id, content) => indexLibraryEntry(db, id, content, "save-suggestion"),
  })
);
