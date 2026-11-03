/**
 * Rebuilding a thought after its text was edited (2026-11-03).
 *
 * By the time this runs, save_thought_edit (SQL) has already, in one transaction:
 * saved the old text to thought_versions, changed the text, cleared the embedding, and
 * removed the old 'summary' chunks and semantic links. This file rebuilds them the same
 * way a new thought is built (enrich-thought), reusing the shared code:
 *   embedding → links → chunks → tags/category/summary.
 *
 * Never throws. Whatever fails is left in the state the backfill jobs already look for:
 *   - no embedding        → backfill-embeddings fills it (then backfill-links links it)
 *   - long but no chunks  → backfill-chunks (thoughts_needing_chunks view)
 *   - chunk w/o embedding → backfill-chunks {"fill_embeddings": true}
 *   - tags/summary failed → the OLD tags/summary stay (and are saved in thought_versions);
 *                           enriched_at is left as it was. Shown as `steps.tags = false`.
 */

import { generateEmbedding, saveThoughtChunksSafe } from './thought-chunks.ts'
import { linkNeighbors, requestEnrichment } from './enrich.ts'

export interface RebuildInput {
  id: string
  userId: string
  content: string
  category: string | null   // the category BEFORE the edit
  outdated: boolean
}

export interface RebuildSteps {
  embedding: boolean
  links: number
  chunks: number
  tags: boolean | 'skipped'
}

export async function rebuildThought(admin: any, t: RebuildInput, label = 'edit-thought'): Promise<RebuildSteps> {
  const steps: RebuildSteps = { embedding: false, links: 0, chunks: 0, tags: 'skipped' }
  try {
    const embedding = await generateEmbedding(t.content)
    if (embedding) {
      const { error } = await admin.from('thoughts').update({ embedding })
        .eq('id', t.id).eq('user_id', t.userId)
      if (error) console.error(`[${label}] saving embedding failed:`, error.message)
      else {
        steps.embedding = true
        // Outdated notes aren't linked to anything new.
        if (!t.outdated) steps.links = await linkNeighbors(admin, t.id, embedding, t.userId)
      }
    } else {
      console.warn(`[${label}] no embedding for ${t.id}; backfill-embeddings will fill it`)
    }
  } catch (err) {
    console.error(`[${label}] embedding/links failed (non-fatal):`, String(err))
  }

  // Does nothing under 2,000 characters (and the old chunks were already removed).
  steps.chunks = await saveThoughtChunksSafe(admin, t.id, t.content, label, 'summary', t.userId)

  // Digests keep their category and aren't re-tagged, same rule as enrich-thought.
  if (t.category !== 'digest' && t.content.length >= 20) {
    try {
      const enrichment = await requestEnrichment(t.content, t.userId, label)
      if (enrichment) {
        const { error } = await admin.from('thoughts')
          .update({ ...enrichment, enriched_at: new Date().toISOString() })
          .eq('id', t.id).eq('user_id', t.userId)
        steps.tags = !error
        if (error) console.error(`[${label}] saving tags failed:`, error.message)
      } else {
        steps.tags = false
      }
    } catch (err) {
      console.error(`[${label}] tagging failed (non-fatal):`, String(err))
      steps.tags = false
    }
  }
  return steps
}
