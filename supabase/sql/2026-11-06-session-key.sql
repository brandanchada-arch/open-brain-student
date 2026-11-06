-- One summary per session (2026-11-06). Safe to run more than once.
-- A summary carries its session's id, so saving again updates that row instead of adding one.
alter table public.session_logs add column if not exists session_key text;
create unique index if not exists idx_session_logs_user_key
  on public.session_logs (user_id, session_key) where session_key is not null;
