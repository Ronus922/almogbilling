-- migrate:up
-- Unified "תקלות ומשימות" module, Phase 1 (11/10/2026) — additive schema only.
-- Decisions: see PROJECT_CONTEXT.md Decisions Log 11/10/2026. Summary:
--   1. New status_v2 ('open'|'in_progress'|'closed') is the new source of
--      truth for both tables. The OLD `status` column (and, on issues,
--      `board_column`) are NOT dropped and NOT written by the new UI — they
--      stay exactly as they are for the old screens being retired from nav.
--   2. priority: reuse the existing column on both tables. Legacy 'low' rows
--      (0 on both tables today, verified before writing this migration) are
--      normalized to 'normal'. The app already writes only normal|high|urgent.
--   3. New primary-assignee pair: assignee_user_id / assignee_supplier_id —
--      NOT the same columns as the already-frozen legacy assigned_to_user_id /
--      supplier_id (pre-migration-047 single-assignee columns, pending a
--      separate approved DROP). The new pair is backfilled from the OLDEST
--      entity_assignees row per item and is kept in sync by the application
--      going forward — entity_assignees remains the multi-assignee junction
--      and the single source of truth for worker row-scoping / notifications;
--      the new columns are a denormalized fast-path for board grouping.
--   4. due_date already exists on both tables — reused, not duplicated.
--   5. source / reporter_* already exist on `issues` (migration
--      20261003074737) with the exact same job the task spec described for a
--      fresh "source" column — reused as-is, no new columns on issues. Tasks
--      has no equivalent yet, so it gets its own source / source_apartment /
--      source_reporter_name trio (additive, display-only in this phase: no
--      write path sets anything but the 'staff' default, since there is no
--      tenant-task-reporting feature).
--   6. closed_at / archived_at / sort_index are new on both tables.
--   7. is_recurring_paused is new on `tasks` only (issues do not recur).

-- ── issues ───────────────────────────────────────────────────────────────

alter table public.issues
  add column status_v2 text,
  add column blocked boolean not null default false,
  add column blocked_reason text,
  add column assignee_user_id uuid references public.users(id) on delete set null,
  add column assignee_supplier_id uuid references public.suppliers(id) on delete set null,
  add column closed_at timestamp with time zone,
  add column archived_at timestamp with time zone,
  add column sort_index numeric;

comment on column public.issues.status_v2 is
  'New source of truth for the unified תקלות/משימות module (11/10/2026). The old `status` + `board_column` stay as-is for the retired kanban; nothing in the new UI reads or writes them.';
comment on column public.issues.assignee_user_id is
  'Single primary assignee (employee), unified module (11/10/2026). NOT the frozen legacy `assigned_to_user_id` (pre-047). Kept in sync with entity_assignees by the application — see entity_assignees for the multi-assignee / worker-scoping source of truth.';
comment on column public.issues.assignee_supplier_id is
  'Single primary assignee (supplier), unified module (11/10/2026). NOT the frozen legacy `supplier_id` (pre-047). See assignee_user_id comment.';
comment on column public.issues.closed_at is
  'When this issue reached status_v2=closed (unified module, 11/10/2026). Backfilled from resolved_at when the legacy status was resolved, else updated_at.';

update public.issues set priority = 'normal' where priority = 'low';

update public.issues set status_v2 = case status
  when 'open' then 'open'
  when 'in_progress' then 'in_progress'
  when 'resolved' then 'closed'
  when 'closed' then 'closed'
end;

alter table public.issues alter column status_v2 set default 'open';
alter table public.issues alter column status_v2 set not null;

alter table public.issues
  add constraint issues_status_v2_check
    check (status_v2 = any (array['open'::text, 'in_progress'::text, 'closed'::text])),
  add constraint issues_primary_assignee_check
    check (not (assignee_user_id is not null and assignee_supplier_id is not null));

update public.issues
   set closed_at = case
         when status = 'resolved' then coalesce(resolved_at, updated_at)
         when status = 'closed' then updated_at
         else null
       end
 where status in ('resolved', 'closed');

-- A card sitting in "today" and still open with no due date yet: default it
-- to today, same rule the task spec gives for backfill.
update public.issues
   set due_date = current_date
 where board_column = 'today' and status_v2 = 'open' and due_date is null;

update public.issues i
   set assignee_user_id = sub.user_id,
       assignee_supplier_id = sub.supplier_id
  from (
    select entity_id, user_id, supplier_id,
           row_number() over (partition by entity_id order by created_at asc, id asc) as rn
      from public.entity_assignees
     where entity_type = 'issue'
  ) sub
 where sub.entity_id = i.id and sub.rn = 1;

create index issues_status_v2_idx on public.issues using btree (status_v2) where not is_archived;
create index issues_assignee_user_idx on public.issues using btree (assignee_user_id) where assignee_user_id is not null;
create index issues_assignee_supplier_idx on public.issues using btree (assignee_supplier_id) where assignee_supplier_id is not null;
create index issues_sort_index_idx on public.issues using btree (sort_index);
create index issues_archived_at_idx on public.issues using btree (archived_at) where archived_at is not null;

-- ── tasks ────────────────────────────────────────────────────────────────

alter table public.tasks
  add column status_v2 text,
  add column blocked boolean not null default false,
  add column blocked_reason text,
  add column assignee_user_id uuid references public.users(id) on delete set null,
  add column assignee_supplier_id uuid references public.suppliers(id) on delete set null,
  add column source text,
  add column source_apartment text,
  add column source_reporter_name text,
  add column closed_at timestamp with time zone,
  add column archived_at timestamp with time zone,
  add column sort_index numeric,
  add column is_recurring_paused boolean not null default false;

comment on column public.tasks.status_v2 is
  'New source of truth for the unified תקלות/משימות module (11/10/2026). The old `status` stays as-is; nothing in the new UI reads or writes it.';
comment on column public.tasks.assignee_user_id is
  'Single primary assignee (employee), unified module (11/10/2026). NOT the frozen legacy `assigned_to_user_id` (pre-047). Kept in sync with entity_assignees by the application — see entity_assignees for the multi-assignee / worker-scoping source of truth.';
comment on column public.tasks.assignee_supplier_id is
  'Single primary assignee (supplier), unified module (11/10/2026). NOT the frozen legacy `supplier_id` (pre-047). See assignee_user_id comment.';
comment on column public.tasks.source is
  'Who opened the task (unified module, 11/10/2026) — mirrors issues.source''s job, kept as a separate column/vocabulary because tasks has no portal/tenant-reporting write path yet: every row is ''staff'' until one exists.';
comment on column public.tasks.closed_at is
  'When this task reached status_v2=closed (unified module, 11/10/2026). Backfilled from completed_at when set, else updated_at.';
comment on column public.tasks.is_recurring_paused is
  'Recurring template temporarily paused (unified module, 11/10/2026) — hides it from overdue/urgency highlighting without ending the series (task_recurrences.is_active means ended, not paused).';

update public.tasks set priority = 'normal' where priority = 'low';

update public.tasks set status_v2 = case status
  when 'open' then 'open'
  when 'in_progress' then 'in_progress'
  when 'done' then 'closed'
  when 'cancelled' then 'closed'
end;

alter table public.tasks alter column status_v2 set default 'open';
alter table public.tasks alter column status_v2 set not null;

alter table public.tasks alter column source set default 'staff';
update public.tasks set source = 'staff';
alter table public.tasks alter column source set not null;

alter table public.tasks
  add constraint tasks_status_v2_check
    check (status_v2 = any (array['open'::text, 'in_progress'::text, 'closed'::text])),
  add constraint tasks_primary_assignee_check
    check (not (assignee_user_id is not null and assignee_supplier_id is not null)),
  add constraint tasks_source_check
    check (source = any (array['staff'::text, 'tenant'::text]));

update public.tasks
   set closed_at = case
         when status in ('done', 'cancelled') then coalesce(completed_at, updated_at)
         else null
       end
 where status in ('done', 'cancelled');

update public.tasks t
   set assignee_user_id = sub.user_id,
       assignee_supplier_id = sub.supplier_id
  from (
    select entity_id, user_id, supplier_id,
           row_number() over (partition by entity_id order by created_at asc, id asc) as rn
      from public.entity_assignees
     where entity_type = 'task'
  ) sub
 where sub.entity_id = t.id and sub.rn = 1;

create index tasks_status_v2_idx on public.tasks using btree (status_v2) where not is_archived;
create index tasks_assignee_user_idx on public.tasks using btree (assignee_user_id) where assignee_user_id is not null;
create index tasks_assignee_supplier_idx on public.tasks using btree (assignee_supplier_id) where assignee_supplier_id is not null;
create index tasks_sort_index_idx on public.tasks using btree (sort_index);
create index tasks_archived_at_idx on public.tasks using btree (archived_at) where archived_at is not null;
create index tasks_recurring_paused_idx on public.tasks using btree (is_recurring_paused) where is_recurring_paused;

-- migrate:down
drop index if exists public.tasks_recurring_paused_idx;
drop index if exists public.tasks_archived_at_idx;
drop index if exists public.tasks_sort_index_idx;
drop index if exists public.tasks_assignee_supplier_idx;
drop index if exists public.tasks_assignee_user_idx;
drop index if exists public.tasks_status_v2_idx;

alter table public.tasks
  drop constraint if exists tasks_source_check,
  drop constraint if exists tasks_primary_assignee_check,
  drop constraint if exists tasks_status_v2_check;

alter table public.tasks
  drop column if exists is_recurring_paused,
  drop column if exists sort_index,
  drop column if exists archived_at,
  drop column if exists closed_at,
  drop column if exists source_reporter_name,
  drop column if exists source_apartment,
  drop column if exists source,
  drop column if exists assignee_supplier_id,
  drop column if exists assignee_user_id,
  drop column if exists blocked_reason,
  drop column if exists blocked,
  drop column if exists status_v2;

drop index if exists public.issues_archived_at_idx;
drop index if exists public.issues_sort_index_idx;
drop index if exists public.issues_assignee_supplier_idx;
drop index if exists public.issues_assignee_user_idx;
drop index if exists public.issues_status_v2_idx;

alter table public.issues
  drop constraint if exists issues_primary_assignee_check,
  drop constraint if exists issues_status_v2_check;

alter table public.issues
  drop column if exists sort_index,
  drop column if exists archived_at,
  drop column if exists closed_at,
  drop column if exists assignee_supplier_id,
  drop column if exists assignee_user_id,
  drop column if exists blocked_reason,
  drop column if exists blocked,
  drop column if exists status_v2;
