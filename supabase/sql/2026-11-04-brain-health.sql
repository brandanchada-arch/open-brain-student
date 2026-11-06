-- Brain health check (2026-11-04). Safe to run more than once. Changes no existing data.
--
-- brain_health() answers "is anything broken?" with counts and dates only, never note text.
-- The app card (through review-proposal), the MCP tool and Brain Calendar's quiet watcher all
-- read this one function, so they can't disagree about what "broken" means.
--
-- problems = really broken (these may send a push, at most one a day).
-- info     = worth knowing, never pushed: flagged library entries, stale notes, older untagged
--            notes, proposals waiting.

-- The PC backup runs on the PC, so the cloud can't see it. export-brain notes each finished
-- export here. Service role only: RLS on, no policies, and no grants to the browser roles.
create table if not exists public.health_heartbeats (
  name text primary key,
  last_ok_at timestamptz not null default now()
);
alter table public.health_heartbeats enable row level security;
revoke all on public.health_heartbeats from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.health_heartbeats from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.health_heartbeats to service_role';
  end if;
end $$;

drop function if exists public.brain_health(uuid, timestamptz);

create function public.brain_health(p_user uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  problems jsonb := '[]'::jsonb;
  job record;
  limit_for interval;
  label text;
  n bigint;
  backup_at timestamptz;
  v_flagged bigint := 0;
  v_stale bigint := 0;
  v_old_untagged bigint := 0;
  v_pending bigint := 0;
begin
  if p_user is null then
    raise exception 'brain_health needs a user';
  end if;

  -- 1. Scheduled jobs. A job that has never run isn't overdue: it may simply be new.
  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    for job in execute $sql$
      select j.jobname, j.active,
             (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid) as last_run,
             (select d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) as last_status
        from cron.job j
       where j.jobname in ('keep-brain-awake', 'weekly-brain-digest', 'weekly-brain-condenser', 'weekly-news-filter', 'brain-calendar-tick')
    $sql$ loop
      limit_for := case job.jobname
        when 'keep-brain-awake' then interval '4 days 12 hours' -- runs every 3-4 days; the 12 hours stops a false alarm at exactly 4
        when 'brain-calendar-tick' then interval '15 minutes'
        else interval '8 days' end;
      label := case job.jobname
        when 'keep-brain-awake' then 'The keep-alive job'
        when 'weekly-brain-digest' then 'The Sunday digest job'
        when 'weekly-brain-condenser' then 'The Sunday condenser job'
        when 'weekly-news-filter' then 'The Saturday news filter job'
        else 'The Brain Calendar job' end;
      -- A job that never ran may simply be new, so being off only counts once it has run.
      -- One failed run of the every-minute job is a hiccup, so the failed check skips that job.
      if not job.active and job.last_run is not null then
        problems := problems || jsonb_build_object('code', 'job_off:' || job.jobname, 'text', label || ' is switched off.');
      elsif not job.active then
        null;
      elsif job.last_run is not null and job.last_run < p_now - limit_for then
        problems := problems || jsonb_build_object('code', 'job_overdue:' || job.jobname,
          'text', label || ' hasn''t run since ' || to_char(job.last_run, 'Mon FMDD') || '.');
      elsif job.last_status = 'failed' and job.jobname <> 'brain-calendar-tick' then
        problems := problems || jsonb_build_object('code', 'job_failed:' || job.jobname, 'text', label || ' failed on its last run.');
      end if;
    end loop;
  end if;

  -- 2. Embeddings that should exist by now (1 hour leaves time for the normal background work).
  select count(*) into n from thoughts
   where user_id = p_user and archived_at is null and embedding is null and created_at < p_now - interval '1 hour';
  if n > 0 then
    problems := problems || jsonb_build_object('code', 'thought_embeddings', 'text', n || ' note(s) have no embedding, so meaning search can''t find them.');
  end if;

  select count(*) into n from library
   where user_id = p_user and embedding is null and created_at < p_now - interval '1 hour';
  if n > 0 then
    problems := problems || jsonb_build_object('code', 'library_embeddings', 'text', n || ' library entries have no embedding.');
  end if;

  select count(*) into n from thought_chunks c join thoughts t on t.id = c.thought_id
   where t.user_id = p_user and t.archived_at is null and c.embedding is null and c.created_at < p_now - interval '1 hour';
  if n > 0 then
    problems := problems || jsonb_build_object('code', 'thought_chunks', 'text', n || ' pieces of long notes have no embedding.');
  end if;

  select count(*) into n from library_chunks c join library l on l.id = c.library_id
   where l.user_id = p_user and c.embedding is null and c.created_at < p_now - interval '1 hour';
  if n > 0 then
    problems := problems || jsonb_build_object('code', 'library_chunks', 'text', n || ' pieces of library entries have no embedding.');
  end if;

  -- 3. New notes the AI should have tagged by now. Notes under 20 characters or with a category
  --    already are skipped by enrich-thought on purpose, so they don't count. "New" = last 14 days.
  select count(*) into n from thoughts
   where user_id = p_user and archived_at is null and enriched_at is null and category is null
     and length(content) >= 20
     and created_at < p_now - interval '1 day' and created_at >= p_now - interval '14 days';
  if n > 0 then
    problems := problems || jsonb_build_object('code', 'untagged_new', 'text', n || ' new note(s) never got tags or a summary.');
  end if;

  -- 4. The PC backup. No heartbeat yet = the new code hasn't seen a backup, so not overdue.
  select last_ok_at into backup_at from health_heartbeats where name = 'pc-backup';
  if backup_at is not null and backup_at < p_now - interval '8 days' then
    problems := problems || jsonb_build_object('code', 'backup_overdue',
      'text', 'The PC backup hasn''t finished since ' || to_char(backup_at, 'Mon FMDD') || '.');
  end if;

  -- 5. Worth knowing, never pushed.
  select count(*) into v_flagged from library
   where user_id = p_user and coalesce(metadata -> 'door_check' ->> 'flagged', 'false') = 'true';

  select count(*) into v_old_untagged from thoughts
   where user_id = p_user and archived_at is null and enriched_at is null and category is null
     and length(content) >= 20 and created_at < p_now - interval '14 days';

  -- Stale: 60 days with no edit and no new linked note, and not already marked outdated.
  select count(*) into v_stale from thoughts t
   where t.user_id = p_user and t.archived_at is null and t.outdated_at is null
     and t.created_at < p_now - interval '60 days'
     and not exists (select 1 from thought_versions v where v.thought_id = t.id and v.edited_at >= p_now - interval '60 days')
     and not exists (select 1 from thought_links k
                      where (k.source_thought_id = t.id or k.target_thought_id = t.id)
                        and k.created_at >= p_now - interval '60 days');

  select count(*) into v_pending from brain_proposals where user_id = p_user and status = 'pending';

  return jsonb_build_object(
    'ok', jsonb_array_length(problems) = 0,
    'problems', problems,
    'info', jsonb_build_object(
      'flagged_library', v_flagged,
      'stale_notes', v_stale,
      'older_untagged', v_old_untagged,
      'proposals_waiting', v_pending
    ),
    'checked_at', p_now
  );
end;
$$;

-- Only the server may call it. Supabase also grants new functions to anon and authenticated
-- directly, so those are revoked by name too.
revoke all on function public.brain_health(uuid, timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.brain_health(uuid, timestamptz) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.brain_health(uuid, timestamptz) to service_role';
  end if;
end $$;
