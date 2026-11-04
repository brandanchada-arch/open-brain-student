// ─────────────────────────────────────────────────────────────
// weekly-condenser, the part that does the work. index.ts only checks the
// caller and passes in the real database, AI gateway and JSON repair, so the
// tests can pass fakes instead.
//
// Reads the last 7 days of the owner's own notes (non-archived, non-outdated
// thoughts), new library rows (skipping ones the door check flagged) and
// session logs, and writes PROPOSALS to brain_proposals. It never changes a
// page itself. Nothing new = nothing written.
// ─────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
import {
  buildCondenserPrompt, cleanProposals, CONDENSER_LIMITS, CONDENSER_SYSTEM_PROMPT, formatItems,
  PAGE_SLUGS, PAGE_TITLES, parseLlmJson, type SourceItem, toSourceItems,
} from "../_shared/core-memory.ts";

export type CondenserDeps = {
  db: any;                                   // service-role supabase client
  ownerId: string;
  callLlm: (systemPrompt: string, prompt: string, maxTokens: number) => Promise<string>;
  repair?: (s: string) => string;
  now?: Date;
};

const MAX_TOKENS = 8000; // generous, so the JSON isn't cut off

export async function runCondenser(deps: CondenserDeps) {
  const { db, ownerId } = deps;
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fail = (what: string, error: any) => { throw new Error(`${what}: ${error?.message ?? error}`); };

  // 1. Make sure the four pages exist, then read them.
  {
    const { error } = await db.from("brain_pages").upsert(
      PAGE_SLUGS.map((slug) => ({ user_id: ownerId, slug, title: PAGE_TITLES[slug] })),
      { onConflict: "user_id,slug", ignoreDuplicates: true },
    );
    if (error) fail("Could not create pages", error);
  }
  const { data: pageRows, error: pageErr } = await db
    .from("brain_pages").select("slug, current_text").eq("user_id", ownerId);
  if (pageErr) fail("Could not read pages", pageErr);
  const pages: Record<string, string> = {};
  for (const p of pageRows ?? []) pages[p.slug] = p.current_text ?? "";

  // 2. Pages that already have a proposal waiting are left alone this week.
  const { data: pendingRows, error: pendErr } = await db
    .from("brain_proposals").select("target_slug").eq("user_id", ownerId).eq("status", "pending");
  if (pendErr) fail("Could not read pending proposals", pendErr);
  const skipSlugs = [...new Set((pendingRows ?? []).map((r: any) => r.target_slug))] as string[];
  if (PAGE_SLUGS.every((s) => skipSlugs.includes(s))) {
    return { ok: true, skipped: true, note: "Every page already has a proposal waiting for review." };
  }

  // 3. This week's notes. Service role skips RLS, so filter by owner and archived/outdated here.
  const { data: thoughts, error: tErr } = await db
    .from("thoughts")
    .select("id, content, summary, category, created_at")
    .eq("user_id", ownerId)
    .is("archived_at", null)
    .is("outdated_at", null)
    .gte("created_at", since)
    .or("category.is.null,category.neq.digest")
    .order("created_at", { ascending: true })
    .limit(300);
  if (tErr) fail("Could not read thoughts", tErr);

  const { data: library, error: lErr } = await db
    .from("library")
    .select("id, title, doc_type, course, topic, summary, content, metadata, created_at")
    .eq("user_id", ownerId)
    .neq("doc_type", "digest") // digests are AI summaries of the same thoughts
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(40);
  if (lErr) fail("Could not read library", lErr);

  const { data: logs, error: sErr } = await db
    .from("session_logs")
    .select("id, title, summary, project, created_at")
    .eq("user_id", ownerId)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(100);
  if (sErr) fail("Could not read session logs", sErr);

  const items = toSourceItems(thoughts ?? [], library ?? [], logs ?? []);
  const flaggedSkipped = (library ?? []).length - items.filter((i) => i.kind === "library").length;

  // 4. First run: empty core page and nothing waiting for it -> also read short
  //    summaries of all active thoughts so there's enough to draft one.
  let bootstrapNotes = "";
  if (!String(pages.core ?? "").trim() && !skipSlugs.includes("core")) {
    const { data: all, error: aErr } = await db
      .from("thoughts")
      .select("id, summary, category, created_at")
      .eq("user_id", ownerId)
      .is("archived_at", null)
      .is("outdated_at", null)
      .or("category.is.null,category.neq.digest")
      .order("created_at", { ascending: false })
      .limit(400);
    if (aErr) fail("Could not read thought summaries", aErr);
    const weekIds = new Set(items.map((i) => i.id));
    const extra: SourceItem[] = (all ?? [])
      .filter((t: any) => t.summary && String(t.summary).trim() && !weekIds.has(t.id))
      .map((t: any, i: number) => {
        const s = String(t.summary).replace(/\s+/g, " ").trim().slice(0, CONDENSER_LIMITS.bootstrapPerItem);
        return {
          ref: `B${i + 1}`, kind: "thought", id: t.id, date: String(t.created_at).slice(0, 10),
          text: s, label: `${String(t.created_at).slice(0, 10)}: ${s.slice(0, 80)}`, category: t.category ?? null,
        };
      });
    bootstrapNotes = formatItems(extra, CONDENSER_LIMITS.bootstrapTotal);
    // Only the summaries that fit in the prompt can be cited as sources.
    items.push(...extra.filter((e) => bootstrapNotes.includes(`[${e.ref}]`)));
  }

  const weekCount = items.filter((i) => !i.ref.startsWith("B")).length;
  if (weekCount === 0 && !bootstrapNotes) {
    return { ok: true, skipped: true, note: "Nothing new in the last 7 days. No proposals written.", flaggedSkipped };
  }

  // 5. Ask the gateway, then check its answer with plain code.
  const prompt = buildCondenserPrompt({
    pages, skipSlugs,
    weekNotes: formatItems(items.filter((i) => !i.ref.startsWith("B"))),
    bootstrapNotes: bootstrapNotes || undefined,
  });
  const answer = await deps.callLlm(CONDENSER_SYSTEM_PROMPT, prompt, MAX_TOKENS);
  const parsed = parseLlmJson(answer, deps.repair);
  if (!parsed) {
    // Fail safely: write nothing. Next week's run tries again.
    throw new Error("The AI's answer was not usable JSON, so nothing was written");
  }
  const { proposals, dropped } = cleanProposals(parsed, items, pages, skipSlugs);
  if (dropped.length) console.log("weekly-condenser dropped:", dropped.join("; "));
  if (proposals.length === 0) {
    return { ok: true, written: 0, note: "No page needed a change.", dropped, notesRead: weekCount, flaggedSkipped };
  }

  const { error: insErr } = await db.from("brain_proposals").insert(
    proposals.map((p) => ({ ...p, user_id: ownerId, status: "pending" })),
  );
  if (insErr) fail("Could not save proposals", insErr);
  return {
    ok: true, written: proposals.length, slugs: proposals.map((p) => p.target_slug),
    dropped, notesRead: weekCount, flaggedSkipped, bootstrap: Boolean(bootstrapNotes),
  };
}
