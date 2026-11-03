// supabase/functions/telegram-bot/index.ts

import { type AskDb, askNotes, formatAskForText, makeAskDeps, splitForTelegram } from "../_shared/ask.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Only Telegram knows this secret (it sends it in a header), and only this one
// Telegram account may use the bot. If either is missing, the bot refuses everything.
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const TELEGRAM_OWNER_ID = Deno.env.get("TELEGRAM_OWNER_ID") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Telegram refuses messages over 4,096 characters, so long replies go out in pieces
// (at most 5; anything longer is cut short with a note).
async function sendTelegramMessage(chatId: number, text: string) {
  for (const part of splitForTelegram(text)) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part }),
    });
  }
}

async function supabaseRequest(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Prefer": "return=representation",
      ...(options.headers || {}),
    },
  });
  return res;
}

// The two database calls /ask needs, through the same REST helper as the rest of this file.
// Always used with OWNER_USER_ID.
const askDb: AskDb = {
  rpc: async (fn, args) => {
    const res = await supabaseRequest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
    const data = await res.json().catch(() => null);
    return res.ok ? { data, error: null } : { data: null, error: { message: data?.message ?? `HTTP ${res.status}` } };
  },
  outdatedIds: async (userId, ids) => {
    if (!ids.length) return new Set<string>();
    const res = await supabaseRequest(
      `thoughts?select=id&user_id=eq.${userId}&archived_at=is.null&outdated_at=not.is.null&id=in.(${ids.join(",")})`,
    );
    // Before the 2026-11-03 SQL there's no outdated_at column (error): treat nothing as outdated.
    const data = res.ok ? await res.json().catch(() => []) : [];
    return new Set((Array.isArray(data) ? data : []).map((r: any) => r.id));
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Not from Telegram (or not set up yet). A non-200 makes Telegram hold the message
  // and try again, so nothing is lost while the webhook is being registered.
  const givenSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!TELEGRAM_WEBHOOK_SECRET || !TELEGRAM_OWNER_ID || givenSecret !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    const body = await req.json();

    // Tells Telegram to send the secret with every message. Run once after changing the secret.
    if (body?.setup === true) {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${SUPABASE_URL}/functions/v1/telegram-bot`,
          secret_token: TELEGRAM_WEBHOOK_SECRET,
        }),
      });
      const result = await res.json().catch(() => ({}));
      return new Response(JSON.stringify({ ok: result.ok === true, description: result.description }), {
        status: res.ok ? 200 : 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const message = body?.message;

    // Anyone else who finds the bot gets no reply. Still a 200, so Telegram doesn't retry.
    if (message && String(message.from?.id ?? "") !== TELEGRAM_OWNER_ID) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (!message || !message.text) {
      // Nothing to do, but Telegram still needs a 200 or it will keep retrying
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const chatId = message.chat.id;
    const text: string = message.text.trim();

    if (/^\/ask(@\w+)?(\s|$)/.test(text)) {
      // Ask mode: a short answer written only from your notes, with the notes it used.
      const question = text.replace(/^\/ask(@\w+)?/, "").trim();
      if (!question) {
        await sendTelegramMessage(chatId, "Send /ask followed by a question, e.g. /ask what did I decide about the budget?");
      } else {
        try {
          const result = await askNotes(
            question,
            makeAskDeps(askDb, OWNER_USER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "telegram-ask"),
          );
          await sendTelegramMessage(chatId, formatAskForText(result));
        } catch (err) {
          console.error("/ask failed:", err);
          await sendTelegramMessage(chatId, "Sorry, I couldn't answer that right now. Try again in a minute.");
        }
      }
    } else if (text.startsWith("/search") || text.startsWith("?")) {
      const query = text.replace(/^\/search/, "").replace(/^\?/, "").trim();

      if (!query) {
        await sendTelegramMessage(chatId, "Send /search followed by what you're looking for.");
      } else {
        const res = await supabaseRequest(
          `thoughts?user_id=eq.${OWNER_USER_ID}&archived_at=is.null&content=ilike.*${encodeURIComponent(query)}*&order=created_at.desc&limit=5`
        );
        const results = await res.json();

        if (!Array.isArray(results) || results.length === 0) {
          await sendTelegramMessage(chatId, `No results found for "${query}".`);
        } else {
          const formatted = results
            .map((r: any, i: number) => `${i + 1}. ${r.content}`)
            .join("\n\n");
          await sendTelegramMessage(chatId, `Found ${results.length} result(s):\n\n${formatted}`);
        }
      }
    } else if (text.startsWith("/recent")) {
      const res = await supabaseRequest(
        `thoughts?user_id=eq.${OWNER_USER_ID}&archived_at=is.null&order=created_at.desc&limit=5`
      );
      const results = await res.json();

      if (!Array.isArray(results) || results.length === 0) {
        await sendTelegramMessage(chatId, "You don't have any thoughts saved yet.");
      } else {
        const formatted = results
          .map((r: any, i: number) => `${i + 1}. ${r.content}`)
          .join("\n\n");
        await sendTelegramMessage(chatId, `Your last ${results.length} thought(s):\n\n${formatted}`);
      }
    } else {
      // Save as a new thought. If the same content was already saved,
      // update that row instead of creating a duplicate (Level 6, Step 0).
      const res = await supabaseRequest("thoughts?on_conflict=dedup_key,user_id", {
        method: "POST",
        headers: {
          "Prefer": "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({
          user_id: OWNER_USER_ID,
          content: text,
          metadata: { source: "telegram" },
        }),
      });

      if (res.ok) {
        await sendTelegramMessage(chatId, "Saved to your brain ✅");
      } else {
        const errText = await res.text();
        console.error("Insert failed:", errText);
        await sendTelegramMessage(chatId, "Sorry, something went wrong saving that.");
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error("Error handling Telegram webhook:", err);
    // Always return 200 so Telegram doesn't keep retrying
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});