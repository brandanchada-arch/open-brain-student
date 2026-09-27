// supabase/functions/backfill-chunks/index.ts
//
// One-time catch-up: chunk every long thought saved before Level 8.
// Works from the thoughts_needing_chunks view, biggest documents first,
// a small batch per call. Run it in a loop until "remaining" reaches 0.
// Safe to interrupt: a thought that got its chunks drops out of the view,
// so the next run picks up where this one stopped.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fillMissingChunkEmbeddings, saveThoughtChunksSafe } from "../_shared/thought-chunks.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(Math.max(Number(body.batch_size) || 10, 1), 10);
  const dryRun = body.dry_run === true;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  async function countRemaining(): Promise<number> {
    const { count, error } = await admin
      .from("thoughts_needing_chunks")
      .select("id", { count: "exact", head: true });
    if (error) throw new Error(`count failed: ${error.message}`);
    return count ?? 0;
  }

  try {
    if (dryRun) {
      return json({ needs_chunks: await countRemaining() });
    }

    // Repair mode: chunks that were saved but whose embedding call failed
    // (usually a provider rate limit) get their embedding filled in.
    if (body.fill_embeddings === true) {
      const limit = Math.min(Math.max(Number(body.batch_size) || 20, 1), 40);
      const { attempted, filled } = await fillMissingChunkEmbeddings(admin, limit);
      const { count, error: countError } = await admin
        .from("thought_chunks")
        .select("id", { count: "exact", head: true })
        .is("embedding", null);
      if (countError) throw new Error(`count failed: ${countError.message}`);
      return json({ attempted, filled, missing: count ?? 0 });
    }

    // Biggest documents first: they matter most if the run gets interrupted.
    const { data: rows, error } = await admin
      .from("thoughts_needing_chunks")
      .select("id, chars")
      .order("chars", { ascending: false })
      .limit(batchSize);
    if (error) throw new Error(`query failed: ${error.message}`);

    let processed = 0;
    let chunked = 0;

    for (const row of rows ?? []) {
      processed++;

      const { data: thought, error: fetchError } = await admin
        .from("thoughts")
        .select("content")
        .eq("id", row.id)
        .single();
      if (fetchError || !thought) {
        console.error(`Fetching thought ${row.id} failed:`, fetchError?.message);
        continue;
      }

      const written = await saveThoughtChunksSafe(
        admin, row.id, thought.content, "backfill-chunks", "summary",
      );
      if (written > 0) {
        chunked++;
        console.log(`Chunked thought ${row.id} (${row.chars} chars) into ${written} chunks`);
      }
    }

    return json({ processed, chunked, remaining: await countRemaining() });
  } catch (err) {
    console.error("backfill-chunks failed:", err);
    return json({ error: String(err) }, 500);
  }
});
