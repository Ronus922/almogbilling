#!/usr/bin/env node
// INVARIANT: a repeated Bllink sync / import never creates a duplicate debtor.
//   apartment_number is the stable business key — `text not null unique`
//   (migration 002). Two active rows for the same apartment = the same debt
//   counted twice (double-billing / double-dun).
//
//   Part 1 — read-only audit of the REAL DB: no two active debtors share an
//            apartment_number.
//   Part 2 — write test in a rolled-back TEMP-table sandbox (never the real
//            data) proving the unique key rejects a repeated insert while
//            allowing a genuinely different apartment.
import { run, scalar, uniqueViolationProof, fail, ok, info } from './_check-lib.mjs';

run('check-no-duplicate-debtors', async () => {
  // --- Part 1: real DB ---------------------------------------------------
  const dupes = scalar(`
    select coalesce(sum(c - 1), 0) from (
      select count(*) c from public.debtors
      where is_archived = false group by apartment_number having count(*) > 1
    ) d`);
  if (dupes === '0') ok('אין דייר פעיל כפול (apartment_number ייחודי)');
  else fail(`${dupes} דיירים כפולים לפי apartment_number — חוב נספר פעמיים!`);

  // --- Part 2: prove the unique key in a rolled-back sandbox -------------
  const proof = uniqueViolationProof({
    ddl: `create temp table debtors_proof (apartment_number text not null unique, total_debt numeric);`,
    first: `insert into debtors_proof values ('A-101', 100);`,
    duplicate: `insert into debtors_proof values ('A-101', 100);`,
    other: `insert into debtors_proof values ('A-102', 100);`,
  });
  if (proof.rejected) ok('ארגז חול: הכנסה חוזרת של אותו apartment_number נדחתה על ידי unique key');
  else fail('ארגז חול: unique key לא מנע דייר כפול');
  if (proof.allowed) ok('ארגז חול: דירה שונה (A-102) מותרת');
  else fail('ארגז חול: unique key חוסם דירה לגיטימית שונה');
  info('ארגז החול (טבלת TEMP בטרנזקציה) בוטל ב-rollback');
});
