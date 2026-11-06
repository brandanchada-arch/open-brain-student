-- About me notes and core page drop-offs (2026-11-05). Safe to run more than once.
-- Run after 2026-11-03-core-memory.sql.
--
-- core_dropped_items: every line that leaves the core page when a change is approved,
--   with the date, so the owner can look back at what used to be current.
-- about_me_notes: short things Claude noticed about the owner in a session. They save
--   without approval, stay out of `thoughts`, and only reach the core page through a
--   normal Sunday proposal. The owner can read and delete them from the app.

-- Marks changes the weekly job applied by itself, so the app can list them.
alter table public.brain_proposals add column if not exists auto_applied boolean not null default false;
-- The page a proposal was written against, so a change that waited can merge onto a newer page.
alter table public.brain_proposals add column if not exists base_text text;
-- Old lines that only changed wording. They aren't logged as dropped.
alter table public.brain_proposals add column if not exists reworded jsonb not null default '[]'::jsonb;

create table if not exists public.core_dropped_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  item        text not null,
  reason      text not null default '',
  proposal_id uuid,
  dropped_at  timestamptz not null default now()
);
create index if not exists idx_core_dropped_user_date on public.core_dropped_items (user_id, dropped_at desc);
alter table public.core_dropped_items enable row level security;
drop policy if exists core_dropped_owner_select on public.core_dropped_items;
create policy core_dropped_owner_select on public.core_dropped_items
  for select to authenticated using (auth.uid() = user_id);
grant select on public.core_dropped_items to authenticated;

create table if not exists public.about_me_notes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  note           text not null check (char_length(note) <= 300),
  project        text,
  session_log_id uuid references public.session_logs (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_about_me_user_date on public.about_me_notes (user_id, created_at desc);
alter table public.about_me_notes enable row level security;
drop policy if exists about_me_owner_select on public.about_me_notes;
create policy about_me_owner_select on public.about_me_notes
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists about_me_owner_delete on public.about_me_notes;
create policy about_me_owner_delete on public.about_me_notes
  for delete to authenticated using (auth.uid() = user_id);
grant select, delete on public.about_me_notes to authenticated;

-- Compares two core lines, ignoring the bullet, case and any dated tag such as
-- "[last mentioned 2026-11-05]", so a new date alone doesn't count as dropping a line.
create or replace function public.core_item_key(line text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(
    regexp_replace(lower(line), '\[[^\]]*\d{4}-\d{2}-\d{2}[^\]]*\]', '', 'g'),
    '^\s*[-*]\s*', ''
  ));
$$;
revoke execute on function public.core_item_key(text) from public, anon, authenticated;
grant execute on function public.core_item_key(text) to service_role;

-- Same parameters as before, so this replaces the old version. New: logs dropped core lines.
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

  if prop.target_slug = 'core' then
    insert into public.core_dropped_items (user_id, item, reason, proposal_id)
    select p_user_id, btrim(old_line), coalesce(prop.reason, ''), prop.id
      from regexp_split_to_table(pg.current_text, E'\n') as old_line
     where btrim(old_line) <> ''
       and btrim(old_line) !~ '^#'
       and public.core_item_key(old_line) not in (
         select public.core_item_key(new_line)
           from regexp_split_to_table(prop.proposed_text, E'\n') as new_line
       )
       and public.core_item_key(old_line) not in (
         select public.core_item_key(reworded_line)
           from jsonb_array_elements_text(prop.reworded) as reworded_line
       );
  end if;

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

-- Same parameters as before. New: an undone change also clears the drop-offs it logged.
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

  perform set_config('brain.allow_history_rewrite', 'on', true); -- this transaction only
  update public.brain_pages
     set current_text = v.current_text, history_text = v.history_text, updated_at = now()
   where id = v.page_id and user_id = p_user_id
  returning brain_pages.slug into slug;
  perform set_config('brain.allow_history_rewrite', 'off', true);
  update public.brain_page_versions set undone_at = now() where id = v.id;
  if v.proposal_id is not null then
    update public.brain_proposals set status = 'rejected', reviewed_at = now()
     where id = v.proposal_id and user_id = p_user_id;
    delete from public.core_dropped_items
     where proposal_id = v.proposal_id and user_id = p_user_id;
  end if;
  return jsonb_build_object('ok', true, 'slug', slug);
end $$;

revoke execute on function public.approve_brain_proposal(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.undo_brain_page_change(uuid) from public, anon, authenticated;
grant execute on function public.approve_brain_proposal(uuid, uuid) to service_role;
grant execute on function public.undo_brain_page_change(uuid) to service_role;
