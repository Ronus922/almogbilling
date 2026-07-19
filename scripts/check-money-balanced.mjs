#!/usr/bin/env node
// INVARIANT: every debtor's money adds up. The Bllink sync REBUILDS
//   total_debt = round2(management_fees + hot_water_debt) unconditionally on
//   every run (src/lib/sync/bllinkPull.ts → mapRow). So a live row where the
//   total ≠ the components, or any negative component, is a bug or manual
//   corruption showing a WRONG debt to the operator / in a WhatsApp dun.
// Read-only against the real DB. Archived rows excluded (frozen history).
import { run, scalar, fail, ok, info } from './_check-lib.mjs';

const BAD = `
  total_debt < 0 or management_fees < 0 or hot_water_debt < 0
  or abs(total_debt - round((management_fees + hot_water_debt)::numeric, 2)) > 0.01`;

run('check-money-balanced', async () => {
  const bad = scalar(`select count(*) from public.debtors where is_archived = false and (${BAD})`);
  if (bad === '0') {
    ok('לכל דייר פעיל total_debt = management_fees + hot_water_debt, ואין ערך שלילי');
  } else {
    fail(`${bad} דיירים עם חוב לא-מאוזן או שלילי (חוב שגוי מוצג!)`);
    const sample = scalar(`
      select string_agg(apartment_number || ': ' ||
        coalesce(management_fees::text,'∅') || '+' || coalesce(hot_water_debt::text,'∅') ||
        '≠' || coalesce(total_debt::text,'∅'), ' | ')
      from (select apartment_number, management_fees, hot_water_debt, total_debt
            from public.debtors where is_archived = false and (${BAD}) limit 5) s`);
    if (sample) info('דוגמאות: ' + sample);
  }
});
