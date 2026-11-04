// ─────────────────────────────────────────────────────────────
// enrich-thought: runs automatically when a new thought is saved
// (triggered by a Supabase Database Webhook on INSERT).
//
// 1. Generates an embedding (the thought's "meaning numbers") — Level 6
// 2. Links it to its closest neighbors in the thought graph   — Level 6
// 3. Chunks long captures into searchable pieces              — Level 8
// 4. Adds tags, a category, and a one-sentence summary        — Level 5
//
// Every AI call goes through a gateway function (call-llm, generate-embedding).
// This file never talks to an AI company directly, so switching providers
// never touches this code.
// ─────────────────────────────────────────────────────────────

import { createClient } from "npm:@supabase/supabase-js@2";
import { saveThoughtChunksSafe } from "../_shared/thought-chunks.ts";
import { linkNeighbors, requestEnrichment } from "../_shared/enrich.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tags/category/summary prompt, JSON parsing and graph linking live in _shared/enrich.ts
// (shared with edit-thought since 2026-11-03, so an edited thought is rebuilt the same way).

// Webhook functions always answer 200, even when they skip or fail.
// The details go to the logs instead.
function done(message: string) {
  console.log(message);
  return new Response(JSON.stringify({ ok: true, message }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Level 6: ask generate-embedding for this text's embedding.
// Returns null on any failure so the rest of enrichment still runs.
// NOTE the Authorization header: one edge function calling another must
// prove who it is, or Supabase rejects the call with a 401 before
// generate-embedding even runs.
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
  try {
    const payload = await req.json().catch(() => null);
    const record = payload?.record;

    if (!record?.id) return done("No thought in the webhook payload. Skipped.");
    if (payload.type && payload.type !== "INSERT") {
      return done(`Event was ${payload.type}, not INSERT. Skipped.`);
    }

    const content = String(record.content ?? record.text ?? "").trim();
    const userId: string | null = record.user_id ?? null;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ── Level 6: embedding + graph links ───────────────────────
    // Runs BEFORE the skip checks below, so every thought gets an
    // embedding and links — including digests and short notes.
    if (content) {
      const embedding = await generateEmbedding(content);
      if (embedding) {
        const { error: embError } = await admin
          .from("thoughts")
          .update({ embedding })
          .eq("id", record.id);

        if (embError) {
          console.error("Saving embedding failed:", embError.message);
        } else {
          console.log(`Embedded thought ${record.id}`);

          // Only link within the same owner's thoughts. No owner = no links.
          if (userId) {
            await linkNeighbors(admin, record.id, embedding, userId);
          } else {
            console.log(`Thought ${record.id} has no user_id. Skipped linking.`);
          }
        }
      }
      // No embedding? Keep going — the backfills can fill it in later.

      // ── Level 8: chunk long captures ─────────────────────────
      // Also runs BEFORE the skip checks, so a long capture always gets
      // chunked. Does nothing under 2,000 characters, and never throws.
      await saveThoughtChunksSafe(admin, record.id, content, "enrich-thought", "summary");
    }

    // ── Level 5: tags, category, summary ───────────────────────

    // Anything that already has a category (like a weekly digest) is left alone.
    if (record.category) {
      return done(`Thought ${record.id} already has category "${record.category}". Skipped tagging.`);
    }

    if (content.length < 20) {
      return done(`Thought ${record.id} is under 20 characters. Skipped tagging.`);
    }

    // Ask the gateway (call-llm) for tags, category and summary.
    const enrichment = await requestEnrichment(content, userId, "enrich-thought");
    if (!enrichment) {
      return done(`No usable AI reply for thought ${record.id}. Skipped tagging.`);
    }

    const { error } = await admin
      .from("thoughts")
      .update({ ...enrichment, enriched_at: new Date().toISOString() })
      .eq("id", record.id);

    if (error) {
      console.error("Database update failed:", error.message);
      return done(`Could not save enrichment for thought ${record.id}.`);
    }

    return done(`Enriched thought ${record.id}: ${enrichment.category}, [${enrichment.tags.join(", ")}]`);
  } catch (err) {
    console.error("Unexpected error:", err);
    return done("Unexpected error. See logs.");
  }
});