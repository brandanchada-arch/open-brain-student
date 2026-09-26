// ─────────────────────────────────────────────────────────────
// call-llm: the LLM gateway for Open Brain
//
// To switch providers, change LLM_PROVIDER in Supabase secrets.
// Add the new provider's API key. No other code changes needed.
//
// LLM_PROVIDER options: anthropic (default), openai, google
// Matching API key secret:
//   anthropic -> ANTHROPIC_API_KEY
//   openai    -> OPENAI_API_KEY
//   google    -> GEMINI_API_KEY
// LLM_MODEL: the model name to use with that provider.
//
// Optional, for the cost receipt in llm_usage:
//   LLM_PRICE_INPUT_PER_MTOK   USD per 1 million input tokens
//   LLM_PRICE_OUTPUT_PER_MTOK  USD per 1 million output tokens
//   If these are missing, cost is logged as 0 (tokens still counted).
// ─────────────────────────────────────────────────────────────

import { createClient } from "npm:@supabase/supabase-js@2";

type LlmRequest = {
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  userId?: string; // who to bill this call to
  source?: string; // which function spent it
};

type LlmResult = { text: string; inputTokens: number; outputTokens: number };
type Adapter = (
  model: string,
  system: string | undefined,
  prompt: string,
  maxTokens: number,
) => Promise<LlmResult>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing secret: ${name}. Add it in Supabase → Edge Functions → Secrets.`);
  }
  return value;
}

// ── Provider adapters: one small translator per AI company ──

const callAnthropic: Adapter = async (model, system, prompt, maxTokens) => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": requireEnv("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Anthropic error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }
  const text = (data.content ?? [])
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("");
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
};

const callOpenAI: Adapter = async (model, system, prompt, maxTokens) => {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_completion_tokens: maxTokens }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
};

const callGoogle: Adapter = async (model, system, prompt, maxTokens) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": requireEnv("GEMINI_API_KEY"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part: { text?: string }) => part.text ?? "")
    .join("");
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
};

const ADAPTERS: Record<string, Adapter> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  google: callGoogle,
};

// ── Cost receipt ──

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Prices in secrets describe LLM_MODEL only. Any other model logs cost 0.
  if (model !== Deno.env.get("LLM_MODEL")) return 0;
  const priceIn = Number(Deno.env.get("LLM_PRICE_INPUT_PER_MTOK"));
  const priceOut = Number(Deno.env.get("LLM_PRICE_OUTPUT_PER_MTOK"));
  if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut)) return 0;
  return (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000;
}

// RULE: a failed receipt must NEVER fail the AI call. The AI already answered.
function logUsage(row: Record<string, unknown>) {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const pending = admin.from("llm_usage").insert(row).then(
      ({ error }) => {
        if (error) console.warn("usage log skipped:", error.message);
      },
      (err) => console.warn("usage log skipped:", err),
    );
    // Let the log finish in the background without making the caller wait.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(pending);
  } catch (err) {
    console.warn("usage log skipped:", err);
  }
}

// ── The gateway itself ──

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // Only your own functions may spend your AI credit.
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: LlmRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "Missing 'prompt'" }, 400);

  const provider = (Deno.env.get("LLM_PROVIDER") ?? "anthropic").toLowerCase();
  const model = body.model ?? Deno.env.get("LLM_MODEL");
  if (!model) {
    return json({ error: "No model set. Add LLM_MODEL in Supabase secrets." }, 500);
  }
  const maxTokens = body.maxTokens ?? 1024;

  try {
    const adapter = ADAPTERS[provider];
    if (!adapter) {
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}". Options: ${Object.keys(ADAPTERS).join(", ")}`,
      );
    }

    const result = await adapter(model, body.systemPrompt, prompt, maxTokens);

    if (body.userId) {
      logUsage({
        user_id: body.userId,
        kind: "chat",
        model,
        source: body.source ?? null,
        prompt_tokens: result.inputTokens,
        completion_tokens: result.outputTokens,
        cost_usd: estimateCost(model, result.inputTokens, result.outputTokens),
      });
    }

    return json({ text: result.text });
  } catch (err) {
    console.error("call-llm failed:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});