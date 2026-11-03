// Builds an in-memory Postgres (PGlite) that looks enough like the live database to test our
// SQL: a fake auth.uid(), an "authenticated" role, the thoughts table with the dedup trigger
// from the course (Level 6), thought_chunks, thought_links, then runs the real SQL files.
// Everything is made up. Requires: npm i --no-save @electric-sql/pglite@0.5.12 @electric-sql/pglite-pgvector@0.0.13
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync } from 'node:fs';

const sqlFile = (name) => readFileSync(new URL(`../../supabase/sql/${name}`, import.meta.url), 'utf8');

export const ALICE = '00000000-0000-0000-0000-00000000000a';   // made-up users
export const BOB = '00000000-0000-0000-0000-00000000000b';

export async function makeDb({ withNewSql = true } = {}) {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(`
    create extension if not exists vector;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    end $$;
    create schema if not exists auth;
    -- Fake Supabase auth.uid(): reads a setting the tests change with set_config.
    create or replace function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;

    create table public.thoughts (
      id uuid primary key default gen_random_uuid(),
      user_id uuid,
      content text not null,
      created_at timestamptz default now(),
      metadata jsonb default '{}'::jsonb,
      embedding vector(3),
      tags text[],
      category text,
      summary text,
      enriched_at timestamptz,
      dedup_key text,
      content_tsv tsvector generated always as (
        to_tsvector('english'::regconfig, coalesce(content, '')) || to_tsvector('simple'::regconfig, coalesce(content, ''))
      ) stored
    );
    -- Course Level 6 dedup trigger + unique index.
    create or replace function thoughts_set_dedup_key() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'INSERT' then
        if new.dedup_key is null then new.dedup_key := md5(new.content); end if;
      elsif TG_OP = 'UPDATE' and new.content is distinct from old.content then
        if old.dedup_key = md5(old.content) then new.dedup_key := md5(new.content); end if;
      end if;
      return new;
    end; $$;
    create trigger trg_thoughts_set_dedup_key before insert or update of content on thoughts
      for each row execute function thoughts_set_dedup_key();
    create unique index idx_thoughts_dedup_key on thoughts (dedup_key, user_id) nulls not distinct;
    alter table thoughts enable row level security;
    create policy own_thoughts on thoughts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

    create table public.thought_chunks (
      id uuid primary key default gen_random_uuid(),
      thought_id uuid not null references thoughts(id),
      origin text not null default 'summary', chunk_index int not null, content text not null,
      char_start int not null default 0, char_end int not null default 0, embedding vector(3),
      content_tsv tsvector generated always as (
        to_tsvector('english'::regconfig, coalesce(content, '')) || to_tsvector('simple'::regconfig, coalesce(content, ''))
      ) stored
    );
    alter table thought_chunks enable row level security;
    create table public.thought_links (
      id uuid primary key default gen_random_uuid(),
      source_thought_id uuid not null references thoughts(id),
      target_thought_id uuid not null references thoughts(id),
      user_id uuid, similarity_score float not null default 0.9,
      link_type text not null default 'semantic', created_at timestamptz default now()
    );
    create table public.brain_clusters (id int, user_id uuid, name text, color text, size int, centroid vector(3));
    grant select, insert, update on all tables in schema public to authenticated;
  `);
  await db.exec(sqlFile('2026-10-22-reference-library.sql'));
  if (withNewSql) await db.exec(sqlFile('2026-11-03-ask-edit-check.sql'));
  await db.exec(`grant select, insert, update on all tables in schema public to authenticated;`);
  return db;
}

/** Runs fn as a signed-in user (role authenticated + auth.uid()), then switches back. */
export async function asUser(db, uid, fn) {
  await db.exec(`select set_config('test.uid', '${uid}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('test.uid', '', false);`); }
}

export async function addThought(db, userId, content, extra = {}) {
  const cols = ['user_id', 'content', ...Object.keys(extra)];
  const vals = [userId, content, ...Object.values(extra)];
  const { rows } = await db.query(
    `insert into thoughts (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) returning id`, vals);
  return rows[0].id;
}
