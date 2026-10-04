-- migrate:up
-- The issues kanban becomes a MANUAL board (Ronen, 04/10/2026 — reverses the
-- drag part of the phase C decision of 03/10/2026).
--
-- issues.board_column — the column a card sits in on /issues: 'awaiting'
-- (ממתין לשיוך) · 'today' (לטיפול היום) · 'in_progress' (בטיפול). "בוצע" is
-- not stored: a resolved / closed issue is in that column by its status, and
-- returns to its stored column if it is reopened. NULL = the computed rule of
-- lib/issues/board.ts (no handler → awaiting; due_date ≤ today → today; else
-- in_progress), live. Every row gets a value here and every new issue gets one
-- at insert, so NULL is only a fallback; from then on only a drag changes the
-- column — not midnight, not a handler or a date saved in the panel.
--
-- issues.sort_order — the order inside a column, ascending, and nothing else.
-- It held leftovers of the priority lanes (manual order until 03/10/2026, no
-- reader since 4b31ef9). Both values below are seeded from the board as it is
-- computed right now — column by the rule, order by compareBoardIssues
-- (overdue first in "today", then urgent → high → normal, due date, time,
-- oldest first) — spaced by 1024 so a drop between two cards writes only the
-- dragged card.
--
-- Reversible: the previous sort_order of every row is copied out first, and
-- the down section restores it exactly. updated_at is left as it was — this
-- is a re-seed, not an edit (the touch trigger is off for the one UPDATE).
create table if not exists public.issues_sort_order_backup (
  issue_id   uuid primary key references public.issues(id) on delete cascade,
  sort_order integer not null,
  backed_up_at timestamptz not null default now()
);

comment on table public.issues_sort_order_backup is
  'issues.sort_order before the manual kanban (04/10/2026). Rollback source for migration 20261004180139; safe to drop once the board is confirmed.';

insert into public.issues_sort_order_backup (issue_id, sort_order)
select id, sort_order from public.issues
on conflict (issue_id) do nothing;

alter table public.issues add column board_column text;

alter table public.issues add constraint issues_board_column_check
  check (board_column is null or board_column in ('awaiting', 'today', 'in_progress'));

comment on column public.issues.board_column is
  'Kanban column on /issues (awaiting · today · in_progress), set at insert from the computed rule and afterwards only by a drag (PATCH /api/issues/[id]/move). NULL = computed live (lib/issues/board.ts). Resolved / closed issues show in "בוצע" whatever this says.';
comment on column public.issues.sort_order is
  'Order inside the issue''s kanban column, ascending (spaced by 1024). A new issue goes above every existing one.';

alter table public.issues disable trigger issues_touch_updated_at;

with today as (
  select (now() at time zone 'Asia/Jerusalem')::date as d
), seeded as (
  select i.id,
         case
           when not exists (select 1 from public.entity_assignees ea
                             where ea.entity_type = 'issue' and ea.entity_id = i.id) then 'awaiting'
           when i.due_date is not null and i.due_date <= t.d then 'today'
           else 'in_progress'
         end as col,
         i.status in ('resolved', 'closed') as done,
         i.due_date < t.d as late,
         i.priority, i.due_date, i.due_time, i.created_at
    from public.issues i cross join today t
), ranked as (
  select id, col,
         (row_number() over (
            partition by done, col
            order by case when col = 'today' and late then 0 else 1 end,
                     case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                     due_date asc nulls last,
                     due_time asc nulls last,
                     created_at asc
          ) - 1) * 1024 as pos
    from seeded
)
update public.issues i
   set board_column = r.col,
       sort_order = r.pos
  from ranked r
 where r.id = i.id;

alter table public.issues enable trigger issues_touch_updated_at;

-- migrate:down
alter table public.issues disable trigger issues_touch_updated_at;

update public.issues i
   set sort_order = b.sort_order
  from public.issues_sort_order_backup b
 where b.issue_id = i.id;

alter table public.issues enable trigger issues_touch_updated_at;

comment on column public.issues.sort_order is null;
alter table public.issues drop constraint if exists issues_board_column_check;
alter table public.issues drop column if exists board_column;
drop table if exists public.issues_sort_order_backup;
