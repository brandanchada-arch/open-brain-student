// supabase/functions/generate-embedding/index.ts
//
// Turns a piece of text into an embedding: a list of 1,536 numbers that
// describes what the text MEANS, so similar ideas end up with similar numbers.
//
// To switch embedding providers, change the model string. The vector dimension
// must stay 1536 or you need a new migration.

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EXPECTED_DIMENSIONS = 1536;

// The model reads at most ~8,000 tokens. 24,000 characters (~6,000 tokens)
// keeps us safely under that limit even for long YouTube transcripts.
const MAX_INPUT_CHARS = 24000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ embedding: null, error: "Use POST" }, 405);
  }

  // 1. Read the text we were asked to embed
  let text = "";
  try {
    const body = await req.json();
    text = typeof body?.text === "string" ? body.text.trim() : "";
  } catch {
    return json({ embedding: null, error: "Body must be JSON: { text: string }" }, 400);
  }
  if (!text) {
    return json({ embedding: null, error: "No text provided" }, 400);
  }

  if (!OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set in Edge Function secrets");
    return json({ embedding: null, error: "OPENROUTER_API_KEY is not set" });
  }

  // 2. Ask the embedding model for the vector, giving up after 15 seconds
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, MAX_INPUT_CHARS),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`OpenRouter returned ${res.status}: ${detail}`);
      return json({ embedding: null, error: `Provider error ${res.status}` });
    }

    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;

    // 3. Make sure we got exactly what the database column expects
    if (!Array.isArray(embedding) || embedding.length !== EXPECTED_DIMENSIONS) {
      console.error("Unexpected embedding shape:", JSON.stringify(data).slice(0, 500));
      return json({ embedding: null, error: "Unexpected embedding shape" });
    }

    return json({ embedding });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Timed out after 15 seconds"
        : String(err);
    console.error("Embedding request failed:", message);
    // Never crash the caller: return null so the thought still saves
    return json({ embedding: null, error: message });
  } finally {
    clearTimeout(timeout);
  }
});