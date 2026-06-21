-- 054 — issues.due_date + issues.due_time (additive)
-- Gives issues an optional due date (+ optional time-of-day), mirroring the
-- tasks.due_date / tasks.due_time pair (migration 023). This lets an issue with
-- a due date surface on the calendar (GET /api/calendar) exactly like a
-- scheduled task. Purely additive: two new nullable columns, no existing data
-- touched. A partial index speeds up the calendar's range scan over only the
-- scheduled (due_date IS NOT NULL) rows.

alter table public.issues
  add column if not exists due_date date,
  add column if not exists due_time time;

create index if not exists issues_due_date_idx
  on public.issues (due_date)
  where due_date is not null;
