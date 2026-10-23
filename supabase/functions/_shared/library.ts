/**
 * Reference Library helpers (2026-10-22).
 *
 * Class material, transcripts, articles and digests are saved to `library`, not `thoughts`.
 * The enrich-thought webhook only fires on `thoughts`, so new library rows get their
 * embedding and chunks here instead, using the same generate-embedding gateway and the same
 * chunking code as thoughts. Nothing here needs a secret beyond what every edge function has.
 *
 * All functions take a service-role client, so callers must pass the right user_id.
 */

import { chunkText, shouldChunk } from './chunking.ts'
import { generateEmbedding } from './thought-chunks.ts'

export interface LibraryEntry {
  user_id: string
  title: string
  content: string
  doc_type: string            // free text: class-notes, transcript, digest, reference, article...
  course?: string | null
  topic?: string | null
  tags?: string[]
  summary?: string | null
  source_url?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Saves an entry and returns its id. The same source_url (or, with matchTitle, the same
 * title + doc_type) for the same user updates the existing row instead of making a copy.
 * Embedding + chunks are NOT done here: call indexLibraryEntry next (inline, or in the
 * background with EdgeRuntime.waitUntil for long content).
 */
export async function saveLibraryEntry(
  admin: any,
  entry: LibraryEntry,
  opts: { matchTitle?: boolean } = {},
): Promise<{ id: string; updated: boolean }> {
  let existingId: string | null = null
  if (entry.source_url) {
    const { data } = await admin.from('library').select('id')
      .eq('user_id', entry.user_id).eq('source_url', entry.source_url).limit(1).maybeSingle()
    existingId = data?.id ?? null
  } else if (opts.matchTitle && entry.title) {
    const { data } = await admin.from('library').select('id')
      .eq('user_id', entry.user_id).eq('doc_type', entry.doc_type).eq('title', entry.title).limit(1).maybeSingle()
    existingId = data?.id ?? null
  }

  const row = {
    user_id: entry.user_id,
    title: (entry.title || firstLine(entry.content)).slice(0, 200),
    content: entry.content,
    doc_type: entry.doc_type,
    course: entry.course ?? null,
    topic: entry.topic ?? null,
    tags: entry.tags ?? [],
    summary: entry.summary ?? null,
    source_url: entry.source_url ?? null,
    metadata: entry.metadata ?? {},
  }

  if (existingId) {
    // A re-capture replaces the text, so its old embedding is cleared until re-indexed.
    const { error } = await admin.from('library').update({ ...row, embedding: null }).eq('id', existingId)
    if (error) throw new Error(`library update failed: ${error.message}`)
    return { id: existingId, updated: true }
  }
  const { data, error } = await admin.from('library').insert(row).select('id').single()
  if (error) throw new Error(`library insert failed: ${error.message}`)
  return { id: data.id, updated: false }
}

/** First non-empty line, without markdown marks, as a fallback title. */
export function firstLine(content: string): string {
  const line = String(content ?? '').trim().split('\n')[0] ?? ''
  return line.replace(/^[#>*\s]+/, '').trim().slice(0, 200) || 'Untitled'
}

/**
 * Embeds the whole entry and (when over 2,000 chars) writes its chunks to library_chunks.
 * Never throws: a failure leaves the entry keyword-searchable, and
 * backfill-chunks {"library": true} repairs it later.
 */
export async function indexLibraryEntry(admin: any, libraryId: string, content: string, label: string): Promise<void> {
  try {
    const embedding = await generateEmbedding(content)
    if (embedding) {
      const { error } = await admin.from('library').update({ embedding }).eq('id', libraryId)
      if (error) console.error(`[${label}] saving library embedding failed:`, error.message)
    }
  } catch (err) {
    console.error(`[${label}] library embedding failed (non-fatal):`, String(err))
  }
  try {
    await saveLibraryChunks(admin, libraryId, content)
  } catch (err) {
    console.error(`[${label}] library chunking failed (non-fatal):`, String(err))
  }
}

/** Replaces an entry's 'summary' chunks. Returns how many were written (0 when short). Throws on failure. */
export async function saveLibraryChunks(admin: any, libraryId: string, content: string): Promise<number> {
  if (!libraryId || !shouldChunk(content)) return 0
  let chunks = chunkText(content)
  if (chunks.length === 0) chunks = [{ index: 0, text: content, charStart: 0, charEnd: content.length }]

  const embeddings: (number[] | null)[] = []
  for (const c of chunks) embeddings.push(await generateEmbedding(c.text))

  const rows = chunks.map((c, i) => ({
    library_id: libraryId,
    origin: 'summary',
    chunk_index: c.index,
    content: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    embedding: embeddings[i],
  }))

  // Embeddings first, then delete-and-insert, same as thought chunks.
  const { error: delErr } = await admin.from('library_chunks').delete().eq('library_id', libraryId).eq('origin', 'summary')
  if (delErr) throw new Error(`library chunk delete failed: ${delErr.message}`)
  const { error: insErr } = await admin.from('library_chunks').insert(rows)
  if (insErr) throw new Error(`library chunk insert failed: ${insErr.message}`)
  return rows.length
}

/** Fills in missing embeddings on library entries and library chunks. */
export async function fillMissingLibraryEmbeddings(admin: any, limit: number): Promise<{ attempted: number; filled: number }> {
  let attempted = 0
  let filled = 0
  const { data: entries, error } = await admin.from('library').select('id, content').is('embedding', null).limit(limit)
  if (error) throw new Error(`library missing-embedding query failed: ${error.message}`)
  for (const row of entries ?? []) {
    attempted++
    const embedding = await generateEmbedding(row.content)
    if (!embedding) continue
    const { error: upErr } = await admin.from('library').update({ embedding }).eq('id', row.id)
    if (!upErr) filled++
  }
  const { data: chunks, error: cErr } = await admin.from('library_chunks').select('id, content').is('embedding', null).limit(limit)
  if (cErr) throw new Error(`library chunk missing-embedding query failed: ${cErr.message}`)
  for (const row of chunks ?? []) {
    attempted++
    const embedding = await generateEmbedding(row.content)
    if (!embedding) continue
    const { error: upErr } = await admin.from('library_chunks').update({ embedding }).eq('id', row.id)
    if (!upErr) filled++
  }
  return { attempted, filled }
}

export interface QuizNote {
  id: string
  title: string
  course: string | null
  topic: string | null
  doc_type: string
  created_at: string
  text: string
}

/**
 * Random library notes for a course/topic, sized for an AI to write quiz questions from.
 * Digests are never used (they summarise thoughts, not class material).
 * course matches exactly (any case); topic matches as "contains" (any case).
 */
export async function pickQuizMaterial(
  admin: any,
  userId: string,
  opts: { course?: string | null; topic?: string | null; docType?: string | null; since?: string | null;
          maxNotes?: number; perNoteChars?: number; totalChars?: number } = {},
): Promise<QuizNote[]> {
  const maxNotes = opts.maxNotes ?? 6
  const perNote = opts.perNoteChars ?? 2500
  const total = opts.totalChars ?? 15000

  let q = admin.from('library').select('id, title, course, topic, doc_type, created_at')
    .eq('user_id', userId).neq('doc_type', 'digest')
  if (opts.course) q = q.ilike('course', escapeLike(opts.course))
  if (opts.topic) q = q.ilike('topic', `%${escapeLike(opts.topic)}%`)
  if (opts.docType) q = q.ilike('doc_type', escapeLike(opts.docType))
  if (opts.since) q = q.gte('created_at', opts.since)
  const { data: list, error } = await q.limit(1000)
  if (error) throw new Error(`library list failed: ${error.message}`)

  // Shuffle (Fisher-Yates), then read only the picked ones' text.
  const pool = [...(list ?? [])]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const picked = pool.slice(0, maxNotes)
  if (picked.length === 0) return []
  const { data: rows, error: cErr } = await admin.from('library').select('id, content').in('id', picked.map((p: any) => p.id))
  if (cErr) throw new Error(`library read failed: ${cErr.message}`)
  const text = new Map<string, string>((rows ?? []).map((r: any) => [r.id, String(r.content ?? '')]))

  const out: QuizNote[] = []
  let used = 0
  for (const p of picked) {
    const body = (text.get(p.id) ?? '').replace(/\s+/g, ' ').trim().slice(0, perNote)
    if (!body) continue
    if (used + body.length > total && out.length > 0) break
    used += body.length
    out.push({ ...p, text: body })
  }
  return out
}

/** Makes user text safe inside a LIKE / ILIKE pattern. */
function escapeLike(s: string): string {
  return String(s).trim().replace(/[\\%_]/g, (c) => '\\' + c)
}

/** Runs work after the response is sent when the platform allows it, otherwise waits for it. */
export async function inBackground(work: Promise<unknown>): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt?.waitUntil) rt.waitUntil(work)
  else await work
}
