-- News filter (2026-11-04). Safe to run more than once. Changes no existing data.
--
-- news_channels: the feeds to read. Filled by a local SQL file kept OUT of this repo.
-- news_runs:     one row per week. Stops a second list that week, and holds the AI cost estimate for the monthly cap.
-- news_listed:   every video ever listed. The primary key is what makes "never list a video twice" certain.
-- All three are service role only: RLS on, no policies, and no grants to the browser roles.

create table if not exists public.news_channels (
  channel_id text primary key check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  name text not null,
  active boolean not null default true,
  added_at timestamptz not null default now()
);

create table if not exists public.news_runs (
  week_key date primary key,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  library_id uuid,
  listed int not null default 0,
  ai_estimate_usd numeric not null default 0,
  note text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.news_listed (
  video_id text primary key check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  channel_id text,
  week_key date not null,
  listed_at timestamptz not null default now()
);

alter table public.news_channels enable row level security;
alter table public.news_runs enable row level security;
alter table public.news_listed enable row level security;

do $$
declare r text; t text;
begin
  foreach t in array array['news_channels', 'news_runs', 'news_listed'] loop
    execute format('revoke all on public.%I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
end $$;
