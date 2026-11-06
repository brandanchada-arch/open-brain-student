-- Read-only, yes/no answers only. It never returns the trigger's definition, because that holds a key.
-- Run BEFORE deploying the locked enrich-thought:
--   npx supabase db query --linked --read-only -f supabase/sql/checks/enrich-webhook-check.sql
-- Safe to deploy only if: one row, has_auth_header = true, role_is_service = true, not_expired = true.
with d as (
  select t.tgname as trigger_name, pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'thoughts' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ~ 'enrich-thought'
), parts as (
  select trigger_name, def,
         translate(substring(def from '[Aa]uthorization"?\s*:\s*"?(?:Bearer\s+)?eyJ[A-Za-z0-9_-]*\.([A-Za-z0-9_-]+)\.'), '-_', '+/') as payload
    from d
), claims as (
  select trigger_name, def,
         case when payload is null then null
              else convert_from(decode(payload || repeat('=', (4 - length(payload) % 4) % 4), 'base64'), 'UTF8')::jsonb end as c
    from parts
)
select trigger_name,
       def ~* 'authorization' as has_auth_header,
       def ~* 'bearer' as has_word_bearer,
       coalesce(c ->> 'role' = 'service_role', false) as role_is_service,
       coalesce((c ->> 'exp')::bigint > extract(epoch from now()), false) as not_expired
  from claims;
