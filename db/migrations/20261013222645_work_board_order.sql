-- migrate:up
-- Per-user, per-module board customization for /issues and /tasks (13/10/2026,
-- Decisions Log: "לוח תקלות/משימות — שיפורים" decision 2). Which employee
-- lanes a viewer sees on the kanban board and in what order — a kind of
-- "saved view", not data: no row = no customization yet, the screen falls
-- back to the default algorithm (decision 3: only employees with an open
-- item in the viewer's scope, busiest first then alphabetical). Saving
-- always rewrites the whole array for (user_id, kind) — same full-replace
-- shape as public.user_reminder_order, one row per owner instead of one row
-- per ordered item, because here the ordered thing (which employees, and in
-- what order) is small and atomic rather than a list that grows over time.
--
-- employee_ids has no FK: an employee who leaves or is deleted (06/10/2026,
-- permanent delete) just stops resolving to a lane — listAssignableUsers()
-- already excludes them, so a stale id is silently dropped at render time,
-- exactly like a stale assignee would be. Nothing to clean up on delete.
--
-- Additive: one new table. No GRANT, no RLS (one service pool, src/lib/db.ts)
-- — the module permission (issues/tasks:view) is enforced by the route.

create table public.user_work_board_order (
  user_id      uuid        not null references public.users(id) on delete cascade,
  kind         text        not null check (kind in ('issue', 'task')),
  employee_ids uuid[]      not null default '{}',
  updated_at   timestamptz not null default now(),
  primary key (user_id, kind)
);

comment on table public.user_work_board_order is
  'Per-user, per-module (issue|task) board customization for /issues and /tasks: which employee lanes to show and in what order (13/10/2026). No row = no customization, fall back to the default algorithm.';
comment on column public.user_work_board_order.employee_ids is
  'The exact lane set, in display order. A stale id (deleted/inactive employee) is dropped at render time, not cleaned up here.';

-- migrate:down
drop table if exists public.user_work_board_order;
