-- migrate:up

-- owner_is_primary_contact is already true on every existing row — untouched.
-- tenant_is_primary_contact defaults to false and was never actually toggled by
-- anyone (the checkbox had no effect until this change), so its current false
-- value carries no real opt-out intent. Flip it to true only where there is an
-- actual tenant phone to notify; rows with no phone stay false (nothing to send
-- to either way, before or after this migration).
update public.contacts
set tenant_is_primary_contact = true
where tenant_is_primary_contact = false
  and tenant_phone is not null
  and btrim(tenant_phone) <> '';

-- Match tenant_is_primary_contact's default to owner_is_primary_contact's and
-- contact_people.is_primary_contact's (both already true), so a tenant added
-- after this migration isn't silently excluded from broadcasts by default.
alter table public.contacts
  alter column tenant_is_primary_contact set default true;

-- migrate:down

-- Revert the default only. Deliberately does not touch existing rows: by the
-- time this could run, real opt-out decisions may have been made through the
-- now-enforced checkbox, and a data-reverting down would destroy them.
alter table public.contacts
  alter column tenant_is_primary_contact set default false;
