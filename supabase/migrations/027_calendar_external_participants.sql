-- 027_calendar_external_participants.sql
-- Module 3 (Calendar) — allow free-text "external" meeting participants.
--
-- Registered participants  = system users only (picker, have a login)        → source 'user'.
-- External participants     = free text (lawyer, contractor, city rep, …)    → source 'external',
--                             stored as display_name_cache only, participant_id IS NULL.
--
-- Historical 'contact' rows (if any) are KEPT for backward-compat read-only display.
--
-- Additive + idempotent. No data is deleted. Safe to re-run.

-- 1) Widen the participant_source CHECK from ('user','contact') to ('user','contact','external').
--    Keep 'contact' so existing rows stay valid; the UI no longer creates new 'contact' rows.
alter table public.calendar_event_participants
  drop constraint if exists calendar_event_participants_participant_source_check;

alter table public.calendar_event_participants
  add constraint calendar_event_participants_participant_source_check
  check (participant_source in ('user', 'contact', 'external'));

-- 2) Allow participant_id to be NULL — external participants have no entity id.
--    (user / contact rows still carry a real uuid; the app enforces NULL only for 'external'.)
--    The unique index (event_id, participant_source, participant_id) keeps working:
--    in Postgres, multiple NULLs are distinct, so several externals on one event do not collide.
alter table public.calendar_event_participants
  alter column participant_id drop not null;
