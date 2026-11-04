// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste any article or web page link and the readable text gets pulled out
// and saved to the Reference Library (table `library`, doc_type "article").
//
// WHY THIS RUNS ON THE SERVER: a web browser is not allowed to fetch pages
// from other websites — that restriction is called CORS and it exists for
// good security reasons. A server has no such limit, so the browser hands
// the link to this function, and this function does the fetching.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { indexLibraryEntry, saveLibraryEntry } from "../_shared/library.ts";
import { doorCheckViaGateway } from "../_shared/door-check.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAX_BYTES = 3_000_000; // don't try to swallow a 50MB page

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// A simple, dependency-free HTML-to-text extractor: strips script/style tags,
// then all remaining tags, then collapses whitespace.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "Untitled page";

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(stripped).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

  return { title, text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Who is asking? Taken from their login token, never from the request body.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ ok: false, error: "Not signed in" }, 401);
    }

    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return jsonResponse({ ok: false, error: "A url is required" }, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return jsonResponse({ ok: false, error: "That is not a valid web address" }, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return jsonResponse({ ok: false, error: "Only http and https links are supported" }, 400);
    }

    const pageRes = await fetch(parsed.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
      }, 422);
    }

    const contentType = pageRes.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(";")[0] || "file"}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415);
    }

    const raw = await pageRes.text();
    if (raw.length > MAX_BYTES) {
      return jsonResponse({ ok: false, error: "That page is too large to process" }, 413);
    }

    const { title, text } = htmlToText(raw);
    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          "Almost no readable text was found. The page probably builds itself " +
          "with JavaScript after loading, which a server cannot see. Try " +
          "copying the text in manually with the Text tab.",
      }, 422);
    }

    // No AI summarizer yet — save the extracted text itself. A later level
    // adds automatic summarizing once an AI key is configured.
    const content = `🔗 ${title}\n${parsed.hostname}\n\n${text.slice(0, 4000)}`;

    // Articles are reference material, so they go to the Reference Library,
    // not the brain. The library row gets its embedding + chunks right here
    // (the enrich-thought webhook only runs for thoughts).
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    // Door check: flags text that tries to instruct an AI. Never blocks the save.
    const door_check = await doorCheckViaGateway(`${title}\n${content}`, user.id, "capture-url");
    let saved: { id: string };
    try {
      saved = await saveLibraryEntry(admin, {
        user_id: user.id,
        title,
        content,
        doc_type: "article",
        source_url: parsed.toString(),
        metadata: { source: "url", title, url: parsed.toString(), hostname: parsed.hostname, door_check },
      });
    } catch (insertError) {
      console.error("[url] Insert failed:", String(insertError));
      return jsonResponse({ ok: false, error: "Could not save that page." }, 500);
    }
    await indexLibraryEntry(admin, saved.id, content, "capture-url");

    return jsonResponse({
      ok: true,
      id: saved.id,
      library: true,
      title,
      hostname: parsed.hostname,
      door_flagged: door_check.flagged,
      preview: content.slice(0, 240) + "…",
    });
  } catch (err) {
    console.error("[url] Failed:", String(err));
    const msg = String(err).includes("timeout") ? "That page took too long to respond." : String(err);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});