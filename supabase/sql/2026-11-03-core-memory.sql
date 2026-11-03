-- ============================================================================
-- Core memory (2026-11-03)
-- Brain pages (core + topic pages), their saved versions (so any approved
-- change can be undone), proposals from the weekly condenser, and short
-- session logs from Claude chats.
--
-- Safe to run more than once. Never deletes rows.
-- Run with:  npx supabase db query --linked -f supabase/sql/2026-11-03-core-memory.sql
-- ============================================================================

-- ---------- 1. brain_pages ----------
-- current_text = what's true now (replaced when you approve a change).
-- history_text = older versions of current_text, newest first (only grows).
create table if not exists public.brain_pages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  slug         text not null,
  title        text not null default '',
  current_text text not null default '',
  history_text text not null default '',
  updated_at   timestamptz not null default now(),
  unique (user_id, slug)
);
alter table public.brain_pages enable row level security;
-- You can read your pages. Changes only happen through review-proposal (service role).
drop policy if exists brain_pages_owner_select on public.brain_pages;
create policy brain_pages_owner_select on public.brain_pages
  for select to authenticated using (auth.uid() = user_id);

-- ---------- 2. brain_page_versions ----------
-- One row per approved change: the page text BEFORE the change. Undo puts it back.
create table if not exists public.brain_page_versions (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references public.brain_pages(id),
  user_id      uuid not null,
  proposal_id  uuid,
  current_text text not null,
  history_text text not null,
  created_at   timestamptz not null default now(),
  undone_at    timestamptz
);
create index if not exists idx_brain_page_versions_user on public.brain_page_versions (user_id, created_at desc);
alter table public.brain_page_versions enable row level security;
drop policy if exists brain_page_versions_owner_select on public.brain_page_versions;
create policy brain_page_versions_owner_select on public.brain_page_versions
  for select to authenticated using (auth.uid() = user_id);

-- ---------- 3. brain_proposals (shared names: other sessions use these) ----------
-- proposed_text is the FULL new "Current" text for the target page.
-- source_ids is a list like [{"kind":"thought","id":"…","label":"Nov 2: first words…"}].
create table if not exists public.brain_proposals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  target_slug   text not null,
  proposed_text text not null,
  reason        text,
  source_ids    jsonb not null default '[]'::jsonb,
  sensitive     boolean not null default false,
  status        text not null default 'pending',
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);
do $$ begin
  alter table public.brain_proposals
    add constraint brain_proposals_status_check check (status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;
create index if not exists idx_brain_proposals_user_status on public.brain_proposals (user_id, status, created_at desc);
alter table public.brain_proposals enable row level security;
-- Read only. Approve / Reject go through review-proposal, which checks your login.
drop policy if exists brain_proposals_owner_select on public.brain_proposals;
create policy brain_proposals_owner_select on public.brain_proposals
  for select to authenticated using (auth.uid() = user_id);

-- ---------- 4. session_logs (service role only: RLS on, no policies) ----------
-- Short summaries of Claude chats, saved by the MCP tool add_session_log.
-- Never full transcripts: the summary is capped.
create table if not exists public.session_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  title      text not null,
  summary    text not null,
  project    text,
  created_at timestamptz not null default now()
);
do $$ begin
  alter table public.session_logs
    add constraint session_logs_size_check
    check (char_length(title) <= 200 and char_length(summary) <= 2000 and char_length(coalesce(project, '')) <= 100);
exception when duplicate_object then null; end $$;
create index if not exists idx_session_logs_user_created on public.session_logs (user_id, created_at desc);
alter table public.session_logs enable row level security;

-- ---------- 5. thoughts: outdated / replaced (another session adds the same columns) ----------
alter table public.thoughts add column if not exists outdated_at timestamptz;
alter table public.thoughts add column if not exists replaced_by uuid references public.thoughts(id);

-- ---------- 6. Seed empty pages for every signed-up user (does nothing if they exist) ----------
insert into public.brain_pages (user_id, slug, title)
select u.id, p.slug, p.title
from auth.users u
cross join (values
  ('core', 'Core'),
  ('job-search', 'Job search'),
  ('courses', 'Courses'),
  ('mega', 'MEGA')
) as p(slug, title)
on conflict (user_id, slug) do nothing;

-- ---------- 7. Approve / reject / undo (called by review-proposal with the service role) ----------
-- Each one takes the user id that review-proposal got from the login token and
-- only touches that user's rows. All three run in one transaction each.

-- Approve: save the page as it is now (a version), move the old "Current" to the
-- top of "History" with a date, put the proposed text in "Current".
create or replace function public.approve_brain_proposal(p_user_id uuid, p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prop public.brain_proposals;
  pg   public.brain_pages;
  new_history text;
begin
  select * into prop from public.brain_proposals
   where id = p_proposal_id and user_id = p_user_id
   for update;
  if not found then raise exception 'Proposal not found'; end if;
  if prop.status <> 'pending' then raise exception 'Proposal was already %', prop.status; end if;

  -- The page should exist (seeded), but make it if it doesn't.
  insert into public.brain_pages (user_id, slug, title)
  values (p_user_id, prop.target_slug, initcap(replace(prop.target_slug, '-', ' ')))
  on conflict (user_id, slug) do nothing;
  select * into pg from public.brain_pages
   where user_id = p_user_id and slug = prop.target_slug
   for update;

  if prop.target_slug = 'core' and char_length(prop.proposed_text) > 4000 then
    raise exception 'Core page text is too long (% characters, limit 4000)', char_length(prop.proposed_text);
  end if;

  insert into public.brain_page_versions (page_id, user_id, proposal_id, current_text, history_text)
  values (pg.id, p_user_id, prop.id, pg.current_text, pg.history_text);

  new_history := case
    when btrim(pg.current_text) = '' then pg.history_text
    else '### Until ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD') || E'\n' || pg.current_text
         || case when pg.history_text = '' then '' else E'\n\n' || pg.history_text end
  end;

  update public.brain_pages
     set current_text = prop.proposed_text, history_text = new_history, updated_at = now()
   where id = pg.id;
  update public.brain_proposals set status = 'approved', reviewed_at = now() where id = prop.id;

  return jsonb_build_object('ok', true, 'slug', prop.target_slug);
end $$;

create or replace function public.reject_brain_proposal(p_user_id uuid, p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prop public.brain_proposals;
begin
  select * into prop from public.brain_proposals
   where id = p_proposal_id and user_id = p_user_id
   for update;
  if not found then raise exception 'Proposal not found'; end if;
  if prop.status <> 'pending' then raise exception 'Proposal was already %', prop.status; end if;
  update public.brain_proposals set status = 'rejected', reviewed_at = now() where id = prop.id;
  return jsonb_build_object('ok', true, 'slug', prop.target_slug);
end $$;

-- Undo: put back the page text from before the most recent approved change
-- (that hasn't been undone already). The undone proposal is marked rejected.
create or replace function public.undo_brain_page_change(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v    public.brain_page_versions;
  slug text;
begin
  select * into v from public.brain_page_versions
   where user_id = p_user_id and undone_at is null
   order by created_at desc, id desc
   limit 1
   for update;
  if not found then raise exception 'Nothing to undo'; end if;

  update public.brain_pages
     set current_text = v.current_text, history_text = v.history_text, updated_at = now()
   where id = v.page_id and user_id = p_user_id
  returning brain_pages.slug into slug;
  update public.brain_page_versions set undone_at = now() where id = v.id;
  if v.proposal_id is not null then
    update public.brain_proposals set status = 'rejected', reviewed_at = now()
     where id = v.proposal_id and user_id = p_user_id;
  end if;
  return jsonb_build_object('ok', true, 'slug', slug);
end $$;

-- Only edge functions (service role) may call these. Supabase grants EXECUTE on new
-- functions to anon and authenticated, so take it away from them by name too.
revoke execute on function public.approve_brain_proposal(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reject_brain_proposal(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.undo_brain_page_change(uuid) from public, anon, authenticated;
grant execute on function public.approve_brain_proposal(uuid, uuid) to service_role;
grant execute on function public.reject_brain_proposal(uuid, uuid) to service_role;
grant execute on function public.undo_brain_page_change(uuid) to service_role;
