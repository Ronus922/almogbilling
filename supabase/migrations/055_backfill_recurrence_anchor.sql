-- 055_backfill_recurrence_anchor.sql
-- Additive data repair (no schema change). Revives recurring series that were
-- created BEFORE the "due date is mandatory for recurrence" guard (migration 053
-- + the API/form guard): a template with neither occurrence_date nor due_date has
-- no anchor, so materializeDue() bails and the series produces ZERO occurrences
-- (invisible in the list, calendar and recurrence tab).
--
-- Fix: anchor each dateless series to its creation date (Asia/Jerusalem), so the
-- engine starts generating its FUTURE occurrences. We set occurrence_date only
-- (the materializer's anchor = coalesce(occurrence_date, due_date)); the template
-- itself stays date-less by design, so only the real materialized instances carry
-- a due_date and appear on the calendar. Past occurrences are never back-filled
-- (materializeDue only creates rows for dates >= today), matching the engine's
-- horizon model. Idempotent: guarded on both anchor columns being null.

begin;

update public.tasks t
   set occurrence_date = (t.created_at at time zone 'Asia/Jerusalem')::date
  from public.task_recurrences r
 where r.id = t.recurrence_id
   and r.is_active = true
   and t.is_recurring_template = true
   and t.occurrence_date is null
   and t.due_date is null;

commit;
