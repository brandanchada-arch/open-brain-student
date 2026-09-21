// supabase/functions/telegram-bot/index.ts

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const message = body?.message;

    if (!message || !message.text) {
      // Nothing to do, but Telegram still needs a 200 or it will keep retrying
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const chatId = message.chat.id;
    const text: string = message.text.trim();

    if (text.startsWith("/search") || text.startsWith("?")) {
      const query = text.replace(/^\/search/, "").replace(/^\?/, "").trim();

      if (!query) {
        await sendTelegramMessage(chatId, "Send /search followed by what you're looking for.");
      } else {
        const res = await supabaseRequest(
          `thoughts?user_id=eq.${OWNER_USER_ID}&content=ilike.*${encodeURIComponent(query)}*&order=created_at.desc&limit=5`
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
        `thoughts?user_id=eq.${OWNER_USER_ID}&order=created_at.desc&limit=5`
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
      // Save as a new thought
            const res = await supabaseRequest("thoughts", {
        method: "POST",
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