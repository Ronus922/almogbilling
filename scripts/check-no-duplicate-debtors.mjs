#!/usr/bin/env node
// INVARIANT: a repeated Bllink sync / import never creates a duplicate debtor.
//   apartment_number is the stable business key — `text not null unique`
//   (migration 002). Two active rows for the same apartment = the same debt
//   counted twice (double-billing / double-dun).
//
//   Part 1 — read-only audit of the REAL DB: no two active debtors share an
//            apartment_number.
//   Part 2 — write test on a THROWAWAY database (created + dropped here, never
//            the real data) proving the unique key rejects a repeated insert
//            while allowing a genuinely different apartment.
import { run, psql, scalar, withTempDb, fail, ok, info } from './_check-lib.mjs';

run('check-no-duplicate-debtors', async () => {
  // --- Part 1: real DB ---------------------------------------------------
  const dupes = scalar(`
    select coalesce(sum(c - 1), 0) from (
      select count(*) c from public.debtors
      where is_archived = false group by apartment_number having count(*) > 1
    ) d`);
  if (dupes === '0') ok('אין דייר פעיל כפול (apartment_number ייחודי)');
  else fail(`${dupes} דיירים כפולים לפי apartment_number — חוב נספר פעמיים!`);

  // --- Part 2: prove the unique key on a throwaway DB --------------------
  const proof = withTempDb((url) => {
    const q = (sql) => psql(sql, { url, args: ['-c'] });
    q(`create table debtors (apartment_number text not null unique, total_debt numeric);`);
    q(`insert into debtors values ('A-101', 100);`);
    let rejected = false;
    try { q(`insert into debtors values ('A-101', 100);`); } catch { rejected = true; }
    let allowed = true;
    try { q(`insert into debtors values ('A-102', 100);`); } catch { allowed = false; }
    return { rejected, allowed };
  });
  if (proof.rejected) ok('DB חד"פ: הכנסה חוזרת של אותו apartment_number נדחתה על ידי unique key');
  else fail('DB חד"פ: unique key לא מנע דייר כפול');
  if (proof.allowed) ok('DB חד"פ: דירה שונה (A-102) מותרת');
  else fail('DB חד"פ: unique key חוסם דירה לגיטימית שונה');
  info('DB חד"פ נמחק');
});
