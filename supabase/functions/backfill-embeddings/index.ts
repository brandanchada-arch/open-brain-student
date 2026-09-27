// supabase/functions/backfill-embeddings/index.ts
//
// One-time catch-up: finds thoughts that have no embedding yet and
// generates one for each, a small batch per call. Run it in a loop
// until "remaining" reaches 0.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(Math.max(Number(body.batch_size) || 5, 1), 20);
  const offset = Math.max(Number(body.offset) || 0, 0);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // The next batch of thoughts that still have no embedding, oldest first
  const { data: rows, error } = await admin
    .from("thoughts")
    .select("id, content")
    .is("embedding", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (error) {
    console.error("Query failed:", error.message);
    return json({ error: error.message }, 500);
  }

  let embedded = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const content = String(row.content ?? "").trim();
    if (!content) {
      failed++;
      continue;
    }

    const embedding = await generateEmbedding(content);
    if (!embedding) {
      failed++;
      continue;
    }

    const { error: updateError } = await admin
      .from("thoughts")
      .update({ embedding })
      .eq("id", row.id);

    if (updateError) {
      console.error(`Saving embedding for ${row.id} failed:`, updateError.message);
      failed++;
    } else {
      embedded++;
    }
  }

  // Thoughts we just embedded drop out of the "no embedding" list on their
  // own, so the offset only moves forward past the ones that FAILED.
  // (Otherwise we'd skip over thoughts that were never processed.)
  const offsetNext = offset + failed;

  const { count } = await admin
    .from("thoughts")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);

  const remaining = Math.max((count ?? 0) - offsetNext, 0);

  return json({
    processed: rows?.length ?? 0,
    embedded,
    failed,
    offset_next: offsetNext,
    remaining,
  });
});