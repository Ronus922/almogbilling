-- migrate:up
-- "הגנת שליחות" (17/10/2026): the OTP request route now also rejects a phone
-- that cleared its per-hour/per-day send ceiling with a flat 429, logged as
-- its own event type — add it to the CHECK the table already enforces.
alter table public.portal_login_events drop constraint portal_login_events_event_type_check;
alter table public.portal_login_events add constraint portal_login_events_event_type_check check (event_type in (
  'code_requested', 'code_sent', 'send_failed', 'code_invalid', 'code_expired',
  'login_success', 'phone_not_found', 'phone_inactive', 'locked_out',
  'unlocked_manually', 'session_revoked', 'send_capped'
));

-- migrate:down
alter table public.portal_login_events drop constraint portal_login_events_event_type_check;
alter table public.portal_login_events add constraint portal_login_events_event_type_check check (event_type in (
  'code_requested', 'code_sent', 'send_failed', 'code_invalid', 'code_expired',
  'login_success', 'phone_not_found', 'phone_inactive', 'locked_out',
  'unlocked_manually', 'session_revoked'
));
