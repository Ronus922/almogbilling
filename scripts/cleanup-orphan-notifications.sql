-- cleanup-orphan-notifications.sql
-- One-off data cleanup (NOT a schema migration — no DDL, DELETE of orphan rows only).
--
-- Removes notifications that point at a task/issue which no longer exists — the
-- ghosts the bell kept showing after an issue was hard-deleted (see the
-- deleteNotificationsForEntity fix that closes this going forward).
--
-- Match is case-insensitive on source_entity_type because producers wrote it
-- inconsistently ('Issue'/'issue', 'Task'/'task'). Tasks are soft-deleted
-- (is_archived=true) so their rows still exist → only genuinely-missing entities
-- are treated as orphans. Idempotent: re-running finds 0.
--
-- Run: psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/cleanup-orphan-notifications.sql

\echo '=== BEFORE: orphaned task/issue notifications ==='
select lower(source_entity_type) as et, count(*) as orphaned
from public.notifications n
where lower(source_entity_type) in ('task','issue')
  and source_entity_id is not null
  and not exists (
    select 1 from public.issues i where lower(n.source_entity_type)='issue' and i.id = n.source_entity_id
    union all
    select 1 from public.tasks  t where lower(n.source_entity_type)='task'  and t.id = n.source_entity_id
  )
group by 1 order by 1;

delete from public.notifications n
where lower(n.source_entity_type) in ('task','issue')
  and n.source_entity_id is not null
  and not exists (
    select 1 from public.issues i where lower(n.source_entity_type)='issue' and i.id = n.source_entity_id
    union all
    select 1 from public.tasks  t where lower(n.source_entity_type)='task'  and t.id = n.source_entity_id
  );

\echo '=== AFTER: orphaned task/issue notifications (expect 0) ==='
select lower(source_entity_type) as et, count(*) as orphaned
from public.notifications n
where lower(source_entity_type) in ('task','issue')
  and source_entity_id is not null
  and not exists (
    select 1 from public.issues i where lower(n.source_entity_type)='issue' and i.id = n.source_entity_id
    union all
    select 1 from public.tasks  t where lower(n.source_entity_type)='task'  and t.id = n.source_entity_id
  )
group by 1 order by 1;
