-- 028_tasks_completed_at_related_entity.sql
-- Tasks module — gap-closing follow-up to 023_tasks_notifications_reminders.sql.
--
-- ADDITIVE ONLY. Adds three nullable columns + one composite index to the
-- existing public.tasks table. No other table touched, no data migration,
-- no renames, no drops. Idempotent (IF NOT EXISTS) — safe to re-run.
--
--   • completed_at        timestamptz — stamped when a task transitions to
--                         'done', cleared when it leaves 'done'. The transition
--                         logic lives in the app layer (src/lib/db/tasks.ts:
--                         createTask / updateTask / reorderTasks), not a DB
--                         trigger, so kanban drag and form edits behave alike.
--   • related_entity_type text — generic polymorphic link
--                         ('debtor' | 'building' | 'supplier' | 'contact').
--                         OPTIONAL and additive: debtor_id remains the PRIMARY
--                         debtor link and is untouched. No data backfill.
--   • related_entity_id   uuid — id of the linked entity. No FK (polymorphic;
--                         every linkable entity uses a uuid PK). 'building' has
--                         no table yet — the type value is reserved for later.
--
-- Soft-delete: DELETE /api/tasks/[id] now sets is_archived = true (project
-- soft-delete convention, like debtors) instead of hard-deleting the row.
-- No schema change is needed for that — is_archived already exists from 023.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/028_tasks_completed_at_related_entity.sql

alter table public.tasks
  add column if not exists completed_at timestamptz;

alter table public.tasks
  add column if not exists related_entity_type text
    check (related_entity_type in ('debtor', 'building', 'supplier', 'contact'));

alter table public.tasks
  add column if not exists related_entity_id uuid;

-- Lookup tasks by their generic linked entity (the spec's required index).
-- assigned_to / status indexes already exist from 023, so only this is new.
create index if not exists tasks_related_entity_idx
  on public.tasks (related_entity_type, related_entity_id);
