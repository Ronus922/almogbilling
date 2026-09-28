-- migrate:up
-- Owners portal: foreign numbers on the roster (decision 28/09/2026).
--
-- The CHECK is the third copy of the ONE phone rule — normalizePhone
-- (src/lib/whatsapp.ts, the '+' branch) and toPortalE164 (src/lib/portal/phone.ts)
-- are the other two; tests/portal-phone.test.ts pins them together:
--   • Israel  → a MOBILE only, '+9725' + 8 digits (unchanged — the code travels
--     over WhatsApp and a landline row could never sign in);
--   • anywhere else → general E.164, '+' then 7–15 digits, first digit 1–9.
-- Every row existing on 28/09/2026 (561, all Israeli mobiles) satisfies the
-- new rule; it was verified before this ran.
alter table public.apartment_owner_phones
  drop constraint apartment_owner_phones_phone_e164_check,
  add constraint apartment_owner_phones_phone_e164_check check (
    phone_e164 ~ '^\+9725[0-9]{8}$'
    or (phone_e164 !~ '^\+972' and phone_e164 ~ '^\+[1-9][0-9]{6,14}$')
  );

comment on column public.apartment_owner_phones.phone_e164 is
  'E.164. Israel: mobile only (+9725XXXXXXXX). Other countries: general E.164 (+CC…, 7–15 digits). Same rule as toPortalE164().';

-- migrate:down
-- Restores the Israeli-only rule. Fails on purpose while a foreign row exists:
-- deactivate/remove those rows first, the constraint will not drop data.
alter table public.apartment_owner_phones
  drop constraint apartment_owner_phones_phone_e164_check,
  add constraint apartment_owner_phones_phone_e164_check check (phone_e164 ~ '^\+9725[0-9]{8}$');

comment on column public.apartment_owner_phones.phone_e164 is null;
