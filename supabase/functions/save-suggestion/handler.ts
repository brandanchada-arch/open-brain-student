// ─────────────────────────────────────────────────────────────
// save-suggestion, the part that does the work. The PC's Friday script calls this with
// MCP_ACCESS_KEY. It saves one suggestion in the Library and queues one push.
// It's a separate function, not an MCP tool, so no AI chat can send pushes through it.
// Saving the same week again updates that entry and sends no second push.
// ─────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
import { doorCheck } from "../_shared/door-check.ts";

export const DOC_TYPE = "suggestion";
export const MAX_TITLE = 120;
export const MAX_SUGGESTION = 1500;
export const MAX_SOURCES = 10;
export const MAX_SOURCE = 200;

export type SuggestionDeps = {
  db: any;
  accessKey: string | null;
  ownerId: string | null;
  saveEntry: (entry: Record<string, unknown>) => Promise<{ id: string; updated: boolean }>;
  indexEntry: (id: string, content: string) => Promise<void>;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function handleSuggestion(req: Request, deps: SuggestionDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "Use POST" });
  if (!deps.accessKey || !deps.ownerId) return json(500, { error: "Not set up" });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(token, deps.accessKey)) return json(401, { error: "Unauthorized" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "Send JSON" }); }

  const week = clean(body?.week);
  const headline = clean(body?.title).replace(/\s+/g, " ");
  const suggestion = clean(body?.suggestion);
  const sources = Array.isArray(body?.sources) ? body.sources.map(clean).filter(Boolean) : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return json(400, { error: "week must be YYYY-MM-DD" });
  if (!headline || headline.length > MAX_TITLE) return json(400, { error: `title must be 1 to ${MAX_TITLE} characters` });
  if (!suggestion || suggestion.length > MAX_SUGGESTION) return json(400, { error: `suggestion must be 1 to ${MAX_SUGGESTION} characters` });
  if (!sources.length || sources.length > MAX_SOURCES || sources.some((s: string) => s.length > MAX_SOURCE)) {
    return json(400, { error: `1 to ${MAX_SOURCES} sources are required, up to ${MAX_SOURCE} characters each` });
  }

  const title = `Friday suggestion: week of ${week}`;
  const content = `${title}\n\n${headline}\n\n${suggestion}\n\nSources:\n${sources.map((s: string) => `- ${s}`).join("\n")}\n\n` +
    "This is only a suggestion. Nothing was changed.";
  try {
    // Patterns only, no AI call. The owner's own PC wrote this, so a false warning costs nothing.
    const door = await doorCheck(content);
    const saved = await deps.saveEntry({
      user_id: deps.ownerId, title, content, doc_type: DOC_TYPE, tags: ["friday-suggestion"], summary: headline,
      metadata: { kind: "friday-suggestion", week, door_check: door },
    });
    await deps.indexEntry(saved.id, content);
    if (!saved.updated) {
      // A failed push must never lose the suggestion.
      try {
        const { error } = await deps.db.from("bc_outbox").insert({
          user_id: deps.ownerId, kind: "suggestion", title: "Friday suggestion", text: "One suggestion for your projects is ready.",
          page: `library/${saved.id}`, urgent: true,
        });
        if (error) console.error("suggestion push not queued:", error.message ?? error);
      } catch (err) {
        console.error("suggestion push not queued:", err);
      }
    }
    return json(200, { ok: true, id: saved.id, updated: saved.updated });
  } catch (err) {
    console.error("save-suggestion failed:", err);
    return json(500, { error: "Could not save the suggestion" });
  }
}
