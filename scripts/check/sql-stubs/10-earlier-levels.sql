-- The schema built in course Levels 2-6 through the SQL Editor. It is NOT in this repo
-- (migration.sql is only the Level 1 table), so this is a best guess from CLAUDE.md and
-- from what supabase/sql/*.sql uses. If the live database differs, this file is what's wrong,
-- not the check. Runs AFTER migration.sql and BEFORE supabase/sql/*.sql.
alter table public.thoughts add column if not exists user_id uuid;
alter table public.thoughts add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.thoughts add column if not exists embedding vector(1536);
alter table public.thoughts add column if not exists tags text[];
alter table public.thoughts add column if not exists category text;
alter table public.thoughts add column if not exists summary text;
alter table public.thoughts add column if not exists enriched_at timestamptz;
alter table public.thoughts add column if not exists dedup_key text;
alter table public.thoughts add column if not exists content_tsv tsvector generated always as (
  to_tsvector('english'::regconfig, coalesce(content, '')) || to_tsvector('simple'::regconfig, coalesce(content, ''))
) stored;

-- Level 2: logins. The Level 1 "anyone can do anything" policy is replaced by owner-only.
drop policy if exists "temporary_open_access" on public.thoughts;
drop policy if exists own_thoughts on public.thoughts;
create policy own_thoughts on public.thoughts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.thought_links (
  id uuid primary key default gen_random_uuid(),
  source_thought_id uuid not null references public.thoughts(id),
  target_thought_id uuid not null references public.thoughts(id),
  user_id uuid,
  similarity_score double precision not null default 0,
  link_type text not null default 'semantic',
  created_at timestamptz default now()
);

create table if not exists public.thought_chunks (
  id uuid primary key default gen_random_uuid(),
  thought_id uuid not null references public.thoughts(id),
  origin text not null default 'summary',
  chunk_index int not null,
  content text not null,
  char_start int not null default 0,
  char_end int not null default 0,
  embedding vector(1536),
  content_tsv tsvector generated always as (
    to_tsvector('english'::regconfig, coalesce(content, '')) || to_tsvector('simple'::regconfig, coalesce(content, ''))
  ) stored
);
alter table public.thought_chunks enable row level security;   -- no policies on purpose

create table if not exists public.brain_clusters (
  id int primary key, user_id uuid, name text, color text, size int, centroid vector(1536)
);

-- Supabase's default grants, so RLS is what protects rows (as on the live project).
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
