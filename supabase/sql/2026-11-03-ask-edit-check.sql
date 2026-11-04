-- ============================================================================
-- Edit notes + outdated notes (2026-11-03, branch cloud/ask-edit-check)
--
-- Only ADDS things: two columns, one table, one new function, and the same
-- search_thoughts / find_links_for_thought with identical parameter lists.
-- Never deletes thoughts. Safe to run more than once.
-- Run with:  npx supabase db query --linked -f supabase/sql/2026-11-03-ask-edit-check.sql
-- Run it BEFORE deploying edit-thought, daily-quiz and gap-questions (they use outdated_at).
-- ============================================================================

-- ---------- 1. thoughts: outdated marker (shared names; another session adds the same) ----------
alter table public.thoughts add column if not exists outdated_at timestamptz;
alter table public.thoughts add column if not exists replaced_by uuid references public.thoughts(id);

-- ---------- 2. thought_versions: the old text, saved before every edit ----------
create table if not exists public.thought_versions (
  id         uuid primary key default gen_random_uuid(),
  thought_id uuid not null references public.thoughts(id),   -- no cascade: nothing deletes silently
  user_id    uuid not null,
  content    text not null,          -- the text BEFORE the edit
  tags       jsonb,                  -- old tags / category / summary, for reference
  category   text,
  summary    text,
  metadata   jsonb,
  edited_at  timestamptz not null default now()
);
create index if not exists idx_thought_versions_thought on public.thought_versions (thought_id, edited_at desc);

alter table public.thought_versions enable row level security;
-- The owner can read their history. Nobody can write from the browser: only the
-- save_thought_edit function below (called by the edit-thought edge function) inserts.
drop policy if exists thought_versions_owner_select on public.thought_versions;
create policy thought_versions_owner_select on public.thought_versions
  for select to authenticated using (auth.uid() = user_id);

-- ---------- 3. save_thought_edit: one transaction for "save old text, then change" ----------
-- New function: drop any older draft first (overload gotcha in CLAUDE.md).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname = 'save_thought_edit'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

-- p_content null      = keep the text.
-- p_outdated null     = keep the outdated state; true = mark outdated (p_replaced_by optional);
--                       false = not outdated any more (clears replaced_by).
-- Returns status 'saved' | 'unchanged' | 'duplicate' (another of your notes already has exactly
-- this text; nothing was changed) | 'not_found' | 'bad_replacement'.
-- When the text changes it also clears the embedding, the 'summary' chunks and the semantic
-- links, so that if the edge function's rebuild fails, backfill-embeddings, backfill-chunks
-- and backfill-links see this thought as "not done yet" and repair it.
create function public.save_thought_edit(
  p_thought_id uuid,
  p_user_id uuid,
  p_content text default null,
  p_outdated boolean default null,
  p_replaced_by uuid default null
)
 returns table(status text, content_changed boolean, version_id uuid, duplicate_id uuid, duplicate_archived boolean)
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare
  t record;
  v_new text := nullif(btrim(p_content), '');
  v_changed boolean := false;
  v_version uuid;
  v_dup record;
begin
  select th.* into t from thoughts th
   where th.id = p_thought_id and th.user_id = p_user_id and th.archived_at is null
   for update;
  if not found then
    return query select 'not_found'::text, false, null::uuid, null::uuid, null::boolean; return;
  end if;

  if p_outdated is true and p_replaced_by is not null then
    -- The replacement must be another of your own, visible thoughts, and must not point back here.
    if p_replaced_by = p_thought_id or not exists (
         select 1 from thoughts r where r.id = p_replaced_by and r.user_id = p_user_id
           and r.archived_at is null and r.replaced_by is distinct from p_thought_id) then
      return query select 'bad_replacement'::text, false, null::uuid, null::uuid, null::boolean; return;
    end if;
  end if;

  v_changed := v_new is not null and v_new is distinct from t.content;

  begin
    if v_changed then
      insert into thought_versions (thought_id, user_id, content, tags, category, summary, metadata)
      values (t.id, t.user_id, t.content, to_jsonb(t.tags), t.category, t.summary, t.metadata)
      returning id into v_version;

      -- trg_thoughts_set_dedup_key recalculates dedup_key here; a clash with another
      -- note raises unique_violation, caught below (and the version insert is undone).
      update thoughts set content = v_new, embedding = null where id = t.id;
      delete from thought_chunks where thought_id = t.id and origin = 'summary';
      delete from thought_links
       where link_type = 'semantic' and (source_thought_id = t.id or target_thought_id = t.id);
    end if;

    if p_outdated is true then
      update thoughts set outdated_at = coalesce(outdated_at, now()), replaced_by = p_replaced_by where id = t.id;
    elsif p_outdated is false then
      update thoughts set outdated_at = null, replaced_by = null where id = t.id;
    end if;
  exception when unique_violation then
    select d.id, d.archived_at is not null as archived into v_dup from thoughts d
     where d.user_id = p_user_id and d.id <> t.id and d.dedup_key = md5(v_new) limit 1;
    return query select 'duplicate'::text, false, null::uuid, v_dup.id, v_dup.archived; return;
  end;

  return query select
    (case when v_changed or p_outdated is not null then 'saved' else 'unchanged' end)::text,
    v_changed, v_version, null::uuid, null::boolean;
end;
$function$;

-- Only the edit-thought edge function (service role) calls this; p_user_id comes from the login token.
revoke execute on function public.save_thought_edit(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;

-- ---------- 4. search_thoughts: outdated notes rank lower (same parameters, same result columns) ----------
-- Identical to the 2026-10-22 version except: `visible` carries outdated_at, and an outdated
-- thought's score is halved before ordering. They still show up; just below current notes.
create or replace function public.search_thoughts(query_text text, p_user_id uuid, query_embedding vector DEFAULT NULL::vector, match_threshold double precision DEFAULT 0.3, match_count integer DEFAULT 10, max_per_document integer DEFAULT 2)
 RETURNS TABLE(id uuid, content text, created_at timestamp with time zone, similarity double precision, matched_chunk text, chunk_origin text, match_source text, fusion_score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  with
  visible as (
    select t.id, t.content, t.created_at, t.embedding, t.content_tsv, t.outdated_at,
           coalesce(t.metadata->>'url', t.metadata->>'video_id') as source_document
    from thoughts t
    where t.user_id = p_user_id
      and t.archived_at is null
  ),
  document_hits as (
    select v.id as thought_id, 1 - (v.embedding <=> query_embedding) as sim,
           null::text as chunk_text, null::text as chunk_origin
    from visible v
    where query_embedding is not null and v.embedding is not null
      and 1 - (v.embedding <=> query_embedding) > match_threshold
  ),
  chunk_hits as (
    select c.thought_id, 1 - (c.embedding <=> query_embedding) as sim,
           c.content as chunk_text, c.origin as chunk_origin
    from thought_chunks c join visible v on v.id = c.thought_id
    where query_embedding is not null and c.embedding is not null
      and 1 - (c.embedding <=> query_embedding) > match_threshold
  ),
  vec_best as (
    select distinct on (u.thought_id) u.thought_id, u.sim, u.chunk_text, u.chunk_origin
    from (select * from document_hits union all select * from chunk_hits) u
    order by u.thought_id, u.sim desc
  ),
  vec_ranked as (
    select vb.*, row_number() over (order by vb.sim desc)::int as vrank from vec_best vb
  ),
  kq as (
    select case when query_text is null or btrim(query_text) = '' then null::tsquery
           else websearch_to_tsquery('english', query_text) || websearch_to_tsquery('simple', query_text)
           end as q
  ),
  kw_doc as (
    select v.id as thought_id, ts_rank(v.content_tsv, kq.q) as krank,
           null::text as chunk_text, null::text as chunk_origin
    from visible v cross join kq where kq.q is not null and v.content_tsv @@ kq.q
  ),
  kw_chunk as (
    select c.thought_id, ts_rank(c.content_tsv, kq.q) as krank,
           c.content as chunk_text, c.origin as chunk_origin
    from thought_chunks c join visible v on v.id = c.thought_id cross join kq
    where kq.q is not null and c.content_tsv @@ kq.q
  ),
  kw_best as (
    select distinct on (u.thought_id) u.thought_id, u.krank, u.chunk_text, u.chunk_origin
    from (select * from kw_doc union all select * from kw_chunk) u
    order by u.thought_id, u.krank desc
  ),
  kw_ranked as (
    select kb.*, row_number() over (order by kb.krank desc)::int as krank_pos
    from (select * from kw_best order by krank desc limit 200) kb
  ),
  fused as (
    select
      coalesce(vr.thought_id, kr.thought_id) as thought_id,
      vr.sim,
      case when vr.thought_id is null then kr.chunk_text
           when kr.thought_id is null then vr.chunk_text
           when kr.krank_pos < vr.vrank then kr.chunk_text
           else vr.chunk_text end as chunk_text,
      case when vr.thought_id is null then kr.chunk_origin
           when kr.thought_id is null then vr.chunk_origin
           when kr.krank_pos < vr.vrank then kr.chunk_origin
           else vr.chunk_origin end as chunk_origin,
      coalesce(1.0 / (60 + vr.vrank), 0) + coalesce(1.0 / (60 + kr.krank_pos), 0) as fusion
    from vec_ranked vr
    full outer join kw_ranked kr on kr.thought_id = vr.thought_id
  ),
  capped as (
    select f.thought_id, f.sim, f.chunk_text, f.chunk_origin,
           -- outdated notes rank lower (half score), never hidden
           (f.fusion * case when v.outdated_at is null then 1.0 else 0.5 end)::float as fusion,
           v.source_document,
           case when v.source_document is null then 1
                else row_number() over (partition by v.source_document order by f.fusion desc)
           end as doc_rank
    from fused f join visible v on v.id = f.thought_id
  )
  select
    v.id, v.content, v.created_at,
    coalesce(c.sim, 0)::float as similarity,
    c.chunk_text as matched_chunk,
    c.chunk_origin,
    case when c.chunk_text is null then 'thought' else 'chunk' end as match_source,
    c.fusion as fusion_score
  from capped c join visible v on v.id = c.thought_id
  where c.doc_rank <= greatest(max_per_document, 1)
  order by c.fusion desc, coalesce(c.sim, 0) desc
  limit match_count;
$function$;

-- ---------- 5. find_links_for_thought: never link TO an outdated note (same parameters) ----------
create or replace function public.find_links_for_thought(source_id uuid, source_embedding vector, p_user_id uuid, match_threshold double precision DEFAULT 0.5, match_count integer DEFAULT 5)
 RETURNS TABLE(target_id uuid, similarity double precision)
 LANGUAGE plpgsql
AS $function$
begin
  return query
    select
      t.id as target_id,
      (1 - (t.embedding <=> source_embedding))::float as similarity
    from thoughts t
    where t.id != source_id
      and t.user_id = p_user_id
      and t.archived_at is null
      and t.outdated_at is null
      and t.embedding is not null
      and (1 - (t.embedding <=> source_embedding)) > match_threshold
    order by t.embedding <=> source_embedding
    limit match_count;
end;
$function$;
