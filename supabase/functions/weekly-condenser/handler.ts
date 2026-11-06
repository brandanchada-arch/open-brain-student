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
  changedLines, isDoorFlagged, PAGE_SLUGS, PAGE_TITLES, parseLlmJson, PENDING_EXPIRY_DAYS, shouldAutoApply, type SourceItem,
  staleFocusLines, toSourceItems,
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

  // 2. An approval nobody answered expires. A waiting change doesn't stop a page updating,
  //    except a page's first draft: a second draft of an empty page would only compete with it.
  const expiry = new Date(now.getTime() - PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  {
    const { error } = await db.from("brain_proposals")
      .update({ status: "rejected", reviewed_at: now.toISOString() })
      .eq("user_id", ownerId).eq("status", "pending").lt("created_at", expiry);
    if (error) fail("Could not expire old proposals", error);
  }
  const { data: pendingRows, error: pendErr } = await db
    .from("brain_proposals").select("target_slug, proposed_text, base_text").eq("user_id", ownerId).eq("status", "pending");
  if (pendErr) fail("Could not read pending proposals", pendErr);
  const skipSlugs = [...new Set((pendingRows ?? []).map((r: any) => r.target_slug))]
    .filter((slug: any) => !String(pages[slug] ?? "").trim()) as string[];
  const waitingLines = (pendingRows ?? [])
    .filter((r: any) => r.base_text != null && !skipSlugs.includes(r.target_slug))
    .flatMap((r: any) => changedLines(r.base_text, r.proposed_text));
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
    .neq("doc_type", "news-list") // video lists from outside feeds, not what you've been doing
    .neq("doc_type", "suggestion") // the AI's own Friday suggestions, not facts about you
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

  // 4. A page's first draft: it's empty and nothing is waiting for it -> also read short summaries
  //    of older notes and library entries. Topic pages get this once: a draft that was rejected,
  //    undone or left to expire isn't tried again. Core keeps trying until it has text.
  const { data: proposalRows, error: propErr } = await db
    .from("brain_proposals").select("target_slug").eq("user_id", ownerId);
  if (propErr) fail("Could not read past proposals", propErr);
  const proposedBefore = new Set((proposalRows ?? []).map((r: any) => r.target_slug));
  const bootstrapSlugs = PAGE_SLUGS.filter((s) =>
    !String(pages[s] ?? "").trim() && !skipSlugs.includes(s) && (s === "core" || !proposedBefore.has(s))) as string[];
  let bootstrapNotes = "";
  if (bootstrapSlugs.length) {
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
    // Library: titles and labels only, never the full text (some entries are huge).
    // Flagged entries, digests and news lists stay out.
    const { data: shelf, error: shelfErr } = await db
      .from("library")
      .select("id, title, doc_type, course, topic, summary, metadata, created_at")
      .eq("user_id", ownerId)
      .neq("doc_type", "digest")
      .neq("doc_type", "news-list")
      .neq("doc_type", "suggestion")
      .order("created_at", { ascending: false })
      .limit(300);
    if (shelfErr) fail("Could not read library summaries", shelfErr);
    const weekLibrary = new Set(items.filter((i) => i.kind === "library").map((i) => i.id));
    (shelf ?? [])
      .filter((l: any) => !isDoorFlagged(l) && !weekLibrary.has(l.id))
      .forEach((l: any, i: number) => {
        const labels = [l.doc_type, l.course, l.topic].filter(Boolean).join(", ");
        const date = String(l.created_at).slice(0, 10);
        const summary = String(l.summary ?? "").replace(/\s+/g, " ").trim();
        const title = String(l.title ?? "Untitled").replace(/\s+/g, " ").trim();
        const text = `${title} (${labels})${summary ? `: ${summary}` : ""}`.slice(0, CONDENSER_LIMITS.bootstrapPerItem);
        extra.push({ ref: `BL${i + 1}`, kind: "library", id: l.id, date, text, label: `Library: ${title.slice(0, 80)}` });
      });
    // The library gets up to half the room, so many older thoughts can't crowd it out.
    // Thoughts get whatever it leaves.
    const shelfNotes = formatItems(extra.filter((e) => e.kind === "library"), CONDENSER_LIMITS.bootstrapTotal / 2);
    bootstrapNotes = shelfNotes +
      formatItems(extra.filter((e) => e.kind !== "library"), CONDENSER_LIMITS.bootstrapTotal - shelfNotes.length);
    // Only the summaries that fit in the prompt can be cited as sources.
    items.push(...extra.filter((e) => bootstrapNotes.includes(`[${e.ref}]`)));
  }

  const weekCount = items.filter((i) => !i.ref.startsWith("B")).length;
  const staleLines = skipSlugs.includes("core") ? [] : staleFocusLines(pages.core, now);
  if (weekCount === 0 && !bootstrapNotes && staleLines.length === 0) {
    return { ok: true, skipped: true, note: "Nothing new in the last 7 days. No proposals written.", flaggedSkipped };
  }

  // 5. Ask the gateway, then check its answer with plain code.
  const prompt = buildCondenserPrompt({
    pages, skipSlugs,
    weekNotes: formatItems(items.filter((i) => !i.ref.startsWith("B"))),
    bootstrapNotes: bootstrapNotes || undefined,
    bootstrapSlugs,
    today: now.toISOString().slice(0, 10),
    staleLines,
    waitingLines,
  });
  const answer = await deps.callLlm(CONDENSER_SYSTEM_PROMPT, prompt, MAX_TOKENS);
  const parsed = parseLlmJson(answer, deps.repair);
  if (!parsed) {
    // Fail safely: write nothing. Next week's run tries again.
    throw new Error("The AI's answer was not usable JSON, so nothing was written");
  }
  const { proposals, dropped } = cleanProposals(parsed, items, pages, skipSlugs, staleLines.length > 0, bootstrapSlugs);
  if (dropped.length) console.log("weekly-condenser dropped:", dropped.join("; "));
  if (proposals.length === 0) {
    return { ok: true, written: 0, note: "No page needed a change.", dropped, notesRead: weekCount, flaggedSkipped };
  }

  const { data: saved, error: insErr } = await db.from("brain_proposals").insert(
    proposals.map((p) => ({ ...p, user_id: ownerId, status: "pending", auto_applied: shouldAutoApply(p, pages) })),
  ).select("id, target_slug, auto_applied");
  if (insErr) fail("Could not save proposals", insErr);

  // Goes through the normal approve function, so undo, history and the dropped list all work.
  // If one fails it just stays waiting in Review.
  const applied: string[] = [];
  for (const row of saved ?? []) {
    if (!row.auto_applied) continue;
    const { error } = await db.rpc("approve_brain_proposal", { p_user_id: ownerId, p_proposal_id: row.id });
    if (error) console.error(`Could not auto-apply ${row.target_slug}:`, error.message);
    else applied.push(row.target_slug);
  }
  return {
    ok: true, written: proposals.length, slugs: proposals.map((p) => p.target_slug), applied,
    dropped, notesRead: weekCount, flaggedSkipped, bootstrap: Boolean(bootstrapNotes),
  };
}
