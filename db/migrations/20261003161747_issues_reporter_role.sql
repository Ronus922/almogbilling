-- migrate:up
-- The role of a portal reporter, in the snapshot (03/10/2026, "פורטל לפי
-- תפקיד"). Owners, tenants and operators all report faults now; the issue
-- remembers which one reported — "דיווח דייר · <שם> · דירה <מספר> · <תפקיד>"
-- on the staff side — exactly as it remembers the name and the apartment: a
-- snapshot of the moment, not a link that changes when the roster does.
--
-- Additive: one nullable column and its check. Every identified portal report
-- so far came through an owner link (the portal opened to owners only), so
-- those are 'owner'; an unidentified one (no roster link) has no role.

alter table public.issues
  add column reporter_role text,
  add constraint issues_reporter_role_check
    check (reporter_role is null or reporter_role in ('owner', 'tenant', 'operator'));

comment on column public.issues.reporter_role is
  'source=portal: the role the reporter held in reporter_apartment when reporting (owner · tenant · operator). NULL for an unidentified reporter and for staff issues.';

update public.issues
   set reporter_role = 'owner'
 where source = 'portal'
   and reporter_contact_id is not null
   and reporter_role is null;

-- migrate:down
alter table public.issues
  drop constraint if exists issues_reporter_role_check,
  drop column if exists reporter_role;
