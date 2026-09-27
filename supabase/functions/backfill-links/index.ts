// supabase/functions/backfill-links/index.ts
//
// One-time catch-up: for every thought that has an embedding, find its
// closest neighbors and save links to them. A small batch per call.
// Run it in a loop until "remaining" reaches 0.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const LINK_THRESHOLD = 0.5;
const LINK_MAX = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The database hands embeddings back as text like "[0.01,-0.02,...]".
// Turn that into a real list of numbers.
function toVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(Math.max(Number(body.batch_size) || 3, 1), 10);
  const offset = Math.max(Number(body.offset) || 0, 0);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Next batch of thoughts that have embeddings, oldest first
  const { data: rows, error } = await admin
    .from("thoughts")
    .select("id, user_id, embedding")
    .not("embedding", "is", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (error) {
    console.error("Query failed:", error.message);
    return json({ error: error.message }, 500);
  }

  let linked = 0;        // thoughts that got at least one new link
  let alreadyDone = 0;   // thoughts that had already searched for neighbors
  let noMatches = 0;     // thoughts with no neighbor above the threshold
  let linksCreated = 0;  // total new links saved

  for (const row of rows ?? []) {
    if (!row.user_id) continue;

    // Has this thought already searched for its own neighbors?
    const { count: existing } = await admin
      .from("thought_links")
      .select("id", { count: "exact", head: true })
      .eq("source_thought_id", row.id);

    if ((existing ?? 0) > 0) {
      alreadyDone++;
      continue;
    }

    const embedding = toVector(row.embedding);
    if (!embedding) continue;

    const { data: neighbors, error: rpcError } = await admin.rpc("find_links_for_thought", {
      source_id: row.id,
      source_embedding: embedding,
      p_user_id: row.user_id,
      match_threshold: LINK_THRESHOLD,
      match_count: LINK_MAX,
    });

    if (rpcError) {
      console.error(`find_links_for_thought failed for ${row.id}:`, rpcError.message);
      continue;
    }

    let createdForThis = 0;
    for (const n of neighbors ?? []) {
      const { error: linkError } = await admin.from("thought_links").insert({
        source_thought_id: row.id,
        target_thought_id: n.target_id,
        user_id: row.user_id,
        similarity_score: n.similarity,
        link_type: "semantic",
      });
      if (!linkError) {
        createdForThis++;
      } else if (linkError.code !== "23505") {
        // 23505 = the link already exists (possibly in the reverse direction) — fine
        console.error(`Saving link ${row.id} → ${n.target_id} failed:`, linkError.message);
      }
    }

    linksCreated += createdForThis;
    if (createdForThis > 0) linked++;
    else noMatches++;
  }

  // Unlike the embedding backfill, this list doesn't shrink as we go,
  // so the offset simply moves forward by one full batch.
  const offsetNext = offset + (rows?.length ?? 0);

  const { count: total } = await admin
    .from("thoughts")
    .select("id", { count: "exact", head: true })
    .not("embedding", "is", null);

  const remaining = Math.max((total ?? 0) - offsetNext, 0);

  return json({
    processed: rows?.length ?? 0,
    linked,
    already_done: alreadyDone,
    no_matches: noMatches,
    links_created: linksCreated,
    offset_next: offsetNext,
    remaining,
  });
});