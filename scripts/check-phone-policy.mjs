#!/usr/bin/env node
// INVARIANT: phone_owner / phone_tenant each hold ONE clean local number
//   (`0` + 8–9 digits) or NULL — never a compound / labelled / junk string.
//   The import + Bllink sync run every value through cleanPhoneField /
//   splitOwnerTenantPhones before writing (see src/lib/whatsapp.ts). A dirty
//   value at rest breaks tel: links, WhatsApp addressing, and owner/tenant
//   split — and means an ingest path skipped the cleaner.
// Read-only against the real DB.
import { run, scalar, fail, ok, info } from './_check-lib.mjs';

const DIRTY = `
  (phone_owner  is not null and phone_owner  !~ '^0[0-9]{8,9}$')
  or (phone_tenant is not null and phone_tenant !~ '^0[0-9]{8,9}$')`;

run('check-phone-policy', async () => {
  const bad = scalar(`select count(*) from public.debtors where ${DIRTY}`);
  if (bad === '0') {
    ok('כל phone_owner/phone_tenant הם מספר מקומי נקי יחיד או NULL');
  } else {
    fail(`${bad} דיירים עם טלפון לא-נקי (מרובה/מתויג/זבל) — נתיב קליטה דילג על הניקוי`);
    const sample = scalar(`
      select string_agg(apartment_number || ': owner=' || coalesce(phone_owner,'∅') ||
        ' tenant=' || coalesce(phone_tenant,'∅'), ' | ')
      from (select apartment_number, phone_owner, phone_tenant
            from public.debtors where ${DIRTY} limit 5) s`);
    if (sample) info('דוגמאות: ' + sample);
  }
});
