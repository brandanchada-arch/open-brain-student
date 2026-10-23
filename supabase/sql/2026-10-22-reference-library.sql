-- ============================================================================
-- Reference Library (2026-10-22)
-- Class notes, transcripts, articles and digests live in `library` instead of
-- `thoughts`, so brain search returns Brandan's own thoughts.
--
-- Safe to run more than once. Never deletes rows.
-- Run with:  npx supabase db query --linked -f supabase/sql/2026-10-22-reference-library.sql
-- The one-time data move (which thoughts went to the library) is NOT in this
-- file: it lists personal ids and lives outside the repo.
-- ============================================================================

-- ---------- 1. library ----------
create table if not exists public.library (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  title            text not null default '',
  content          text not null,
  doc_type         text not null default 'reference',   -- free text on purpose (no CHECK)
  course           text,                                 -- e.g. BUS-485, null if none
  topic            text,
  tags             text[] not null default '{}',
  summary          text,
  source_url       text,
  metadata         jsonb not null default '{}'::jsonb,
  embedding        vector(1536),
  content_tsv      tsvector generated always as (
                     to_tsvector('english'::regconfig, coalesce(content, ''))
                     || to_tsvector('simple'::regconfig, coalesce(content, ''))
                   ) stored,
  brain_thought_id uuid unique,                          -- the thought it was moved from
  created_at       timestamptz not null default now(),   -- moved rows keep the thought's date
  moved_at         timestamptz
);

create index if not exists idx_library_user_filters on public.library (user_id, course, doc_type, topic);
create index if not exists idx_library_source_url on public.library (user_id, source_url);
create index if not exists idx_library_embedding on public.library using hnsw (embedding vector_cosine_ops);
create index if not exists idx_library_content_tsv on public.library using gin (content_tsv);

alter table public.library enable row level security;

drop policy if exists library_owner_select on public.library;
create policy library_owner_select on public.library
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists library_owner_insert on public.library;
create policy library_owner_insert on public.library
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists library_owner_update on public.library;
create policy library_owner_update on public.library
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- 2. library_chunks (mirrors thought_chunks; service role only) ----------
create table if not exists public.library_chunks (
  id          uuid primary key default gen_random_uuid(),
  library_id  uuid not null references public.library(id),
  origin      text not null default 'summary',
  chunk_index int  not null,
  content     text not null,
  char_start  int  not null,
  char_end    int  not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  content_tsv tsvector generated always as (
                to_tsvector('english'::regconfig, coalesce(content, ''))
                || to_tsvector('simple'::regconfig, coalesce(content, ''))
              ) stored,
  unique (library_id, origin, chunk_index)
);
create index if not exists idx_library_chunks_library on public.library_chunks (library_id);
create index if not exists idx_library_chunks_embedding on public.library_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists idx_library_chunks_content_tsv on public.library_chunks using gin (content_tsv);
-- RLS on with NO policies, like thought_chunks: only the service role can read or write.
alter table public.library_chunks enable row level security;

-- ---------- 3. library_links (takeaway thought -> library entry it came from) ----------
create table if not exists public.library_links (
  thought_id uuid not null references public.thoughts(id),
  library_id uuid not null references public.library(id),
  note       text,
  created_at timestamptz not null default now(),
  primary key (thought_id, library_id)
);
alter table public.library_links enable row level security;
drop policy if exists library_links_owner_select on public.library_links;
create policy library_links_owner_select on public.library_links
  for select to authenticated using (
    exists (select 1 from public.library l where l.id = library_id and l.user_id = auth.uid())
  );

-- ---------- 4. thoughts: archive columns + hide archived rows ----------
alter table public.thoughts add column if not exists archived_at timestamptz;
alter table public.thoughts add column if not exists library_id uuid references public.library(id);

-- RESTRICTIVE = ANDed with the existing own_thoughts policy. The live web app
-- (signed-in users) stops seeing archived thoughts without a redeploy.
-- The service role ignores RLS, so functions using it filter archived_at themselves.
drop policy if exists hide_archived_thoughts on public.thoughts;
create policy hide_archived_thoughts on public.thoughts
  as restrictive for select to authenticated using (archived_at is null);

-- ---------- 5. brain functions: same parameter lists, plus "archived_at is null" ----------
-- (CLAUDE.md gotcha: same parameters, so create or replace updates in place, no new overload.)

create or replace function public.search_thoughts(query_text text, p_user_id uuid, query_embedding vector DEFAULT NULL::vector, match_threshold double precision DEFAULT 0.3, match_count integer DEFAULT 10, max_per_document integer DEFAULT 2)
 RETURNS TABLE(id uuid, content text, created_at timestamp with time zone, similarity double precision, matched_chunk text, chunk_origin text, match_source text, fusion_score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  with
  visible as (
    select t.id, t.content, t.created_at, t.embedding, t.content_tsv,
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
    select f.*, v.source_document,
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
      and t.embedding is not null
      and (1 - (t.embedding <=> source_embedding)) > match_threshold
    order by t.embedding <=> source_embedding
    limit match_count;
end;
$function$;

create or replace function public.brain_graph()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with me as (select auth.uid() uid),
  t as (
    select th.id, th.created_at, th.category, th.embedding,
           left(regexp_replace(coalesce(nullif(th.summary, ''), th.content), '\s+', ' ', 'g'), 110) label
    from thoughts th, me
    where th.user_id = me.uid and th.category is distinct from 'digest' and th.archived_at is null
  ),
  near as (
    select t.id,
      (select array_agg(x.id order by x.d) from (select bc.id, t.embedding <=> bc.centroid d from brain_clusters bc, me where bc.user_id = me.uid order by 2 limit 2) x) cids,
      (select array_agg(x.d order by x.d) from (select t.embedding <=> bc.centroid d from brain_clusters bc, me where bc.user_id = me.uid order by 1 limit 2) x) ds
    from t where t.embedding is not null
  ),
  e as (
    select least(l.source_thought_id, l.target_thought_id) a, greatest(l.source_thought_id, l.target_thought_id) b, max(l.similarity_score) w
    from thought_links l
    where l.source_thought_id in (select id from t) and l.target_thought_id in (select id from t)
      and l.source_thought_id <> l.target_thought_id
    group by 1, 2
  )
  select jsonb_build_object(
    'clusters', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'color', color, 'size', size) order by id)
                 from brain_clusters, me where user_id = me.uid), '[]'::jsonb),
    'nodes', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'label', t.label, 'cat', t.category, 'at', t.created_at,
                 'c1', n.cids[1], 'c2', n.cids[2],
                 -- 0 = squarely in one topic, 0.5 = halfway between two topics
                 'w', case when n.ds[2] is null then 0 else round((1 / (1 + exp((n.ds[2] - n.ds[1]) / 0.09)))::numeric, 3) end)
                 order by t.created_at)
               from t left join near n using (id)), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(jsonb_build_array(a, b, round(w::numeric, 3))) from e), '[]'::jsonb),
    'at', now()
  );
$function$;

create or replace view public.thoughts_needing_chunks as
 SELECT id,
    length(content) AS chars,
    created_at
   FROM thoughts t
  WHERE length(content) > 2000 AND t.archived_at IS NULL AND NOT (EXISTS ( SELECT 1
           FROM thought_chunks c
          WHERE c.thought_id = t.id AND c.origin = 'summary'::text))
  ORDER BY (length(content)) DESC;

-- Long library entries that have no chunks yet (backfill-chunks {"library": true} works from this).
create or replace view public.library_needing_chunks as
 SELECT id,
    length(content) AS chars,
    created_at
   FROM library l
  WHERE length(content) > 2000 AND NOT (EXISTS ( SELECT 1
           FROM library_chunks c
          WHERE c.library_id = l.id AND c.origin = 'summary'::text))
  ORDER BY (length(content)) DESC;
-- Views run with their owner's rights, so keep these away from browser roles.
revoke all on public.library_needing_chunks from anon, authenticated;

-- ---------- 6. search_library: hybrid RRF over library + library_chunks ----------
-- New function, so drop any older draft first (overload gotcha).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname = 'search_library'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create function public.search_library(
  query_text text,
  p_user_id uuid,
  query_embedding vector DEFAULT NULL::vector,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 10,
  p_course text DEFAULT NULL,
  p_doc_type text DEFAULT NULL,
  p_topic text DEFAULT NULL
)
 RETURNS TABLE(id uuid, title text, content text, doc_type text, course text, topic text,
               created_at timestamp with time zone, similarity double precision, matched_chunk text,
               chunk_origin text, match_source text, fusion_score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  with
  visible as (
    select l.id, l.title, l.content, l.doc_type, l.course, l.topic, l.created_at, l.embedding, l.content_tsv
    from library l
    where l.user_id = p_user_id
      and (nullif(btrim(p_course), '') is null or lower(l.course) = lower(btrim(p_course)))
      and (nullif(btrim(p_doc_type), '') is null or lower(l.doc_type) = lower(btrim(p_doc_type)))
      and (nullif(btrim(p_topic), '') is null or l.topic ilike '%' || btrim(p_topic) || '%')
  ),
  -- No query at all (only filters): newest entries first, so filters alone still list something.
  browse as (
    select v.id as lib_id, row_number() over (order by v.created_at desc)::int as brank
    from visible v
    where (query_text is null or btrim(query_text) = '') and query_embedding is null
  ),
  document_hits as (
    select v.id as lib_id, 1 - (v.embedding <=> query_embedding) as sim,
           null::text as chunk_text, null::text as chunk_origin
    from visible v
    where query_embedding is not null and v.embedding is not null
      and 1 - (v.embedding <=> query_embedding) > match_threshold
  ),
  chunk_hits as (
    select c.library_id as lib_id, 1 - (c.embedding <=> query_embedding) as sim,
           c.content as chunk_text, c.origin as chunk_origin
    from library_chunks c join visible v on v.id = c.library_id
    where query_embedding is not null and c.embedding is not null
      and 1 - (c.embedding <=> query_embedding) > match_threshold
  ),
  vec_best as (
    select distinct on (u.lib_id) u.lib_id, u.sim, u.chunk_text, u.chunk_origin
    from (select * from document_hits union all select * from chunk_hits) u
    order by u.lib_id, u.sim desc
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
    select v.id as lib_id, ts_rank(v.content_tsv, kq.q) as krank,
           null::text as chunk_text, null::text as chunk_origin
    from visible v cross join kq where kq.q is not null and v.content_tsv @@ kq.q
  ),
  kw_chunk as (
    select c.library_id as lib_id, ts_rank(c.content_tsv, kq.q) as krank,
           c.content as chunk_text, c.origin as chunk_origin
    from library_chunks c join visible v on v.id = c.library_id cross join kq
    where kq.q is not null and c.content_tsv @@ kq.q
  ),
  kw_best as (
    select distinct on (u.lib_id) u.lib_id, u.krank, u.chunk_text, u.chunk_origin
    from (select * from kw_doc union all select * from kw_chunk) u
    order by u.lib_id, u.krank desc
  ),
  kw_ranked as (
    select kb.*, row_number() over (order by kb.krank desc)::int as krank_pos
    from (select * from kw_best order by krank desc limit 200) kb
  ),
  fused as (
    select
      coalesce(vr.lib_id, kr.lib_id) as lib_id,
      vr.sim,
      case when vr.lib_id is null then kr.chunk_text
           when kr.lib_id is null then vr.chunk_text
           when kr.krank_pos < vr.vrank then kr.chunk_text
           else vr.chunk_text end as chunk_text,
      case when vr.lib_id is null then kr.chunk_origin
           when kr.lib_id is null then vr.chunk_origin
           when kr.krank_pos < vr.vrank then kr.chunk_origin
           else vr.chunk_origin end as chunk_origin,
      coalesce(1.0 / (60 + vr.vrank), 0) + coalesce(1.0 / (60 + kr.krank_pos), 0) as fusion
    from vec_ranked vr
    full outer join kw_ranked kr on kr.lib_id = vr.lib_id
    union all
    select b.lib_id, null, null, null, 1.0 / (60 + b.brank) from browse b
  )
  select
    v.id, v.title, v.content, v.doc_type, v.course, v.topic, v.created_at,
    coalesce(f.sim, 0)::float as similarity,
    f.chunk_text as matched_chunk,
    f.chunk_origin,
    case when f.chunk_text is null then 'entry' else 'chunk' end as match_source,
    f.fusion as fusion_score
  from fused f join visible v on v.id = f.lib_id
  order by f.fusion desc, coalesce(f.sim, 0) desc
  limit match_count;
$function$;

-- Only the edge functions (service role) call this; p_user_id comes from them.
revoke execute on function public.search_library(text, uuid, vector, double precision, integer, text, text, text) from public, anon, authenticated;
