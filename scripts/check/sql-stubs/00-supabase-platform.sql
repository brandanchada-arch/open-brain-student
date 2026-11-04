-- Stand-ins for things the real Supabase platform provides, so our SQL files can load
-- into PGlite (Postgres running in memory). Nothing here is real data or a real key.
-- Not stubbed on purpose: pg_cron, pg_net, Vault. A file that needs them fails the
-- check with the reason, instead of pretending to pass.
create extension if not exists vector;   -- pgvector (PGlite ships it as a plugin)

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
-- Supabase's auth.uid(): the signed-in user's id. Here it reads a setting (empty = nobody).
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
