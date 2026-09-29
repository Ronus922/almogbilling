#!/usr/bin/env node
/**
 * The DB-backed vitest suites gate themselves on WA_TEST_DATABASE_URL. Until
 * 29/09/2026 CI never set it, so 114 tests across 9 files skipped on every run
 * — and skipped reads as green. `tests/finance-portal.test.ts` even reported
 * its FILE as "passed" with all 10 of its tests skipped.
 *
 * So after the DB run, prove it actually ran: any skipped test is a failure.
 * This is the part that stops the hole reopening quietly — if someone adds a
 * suite behind a new env switch CI does not set, this step says so by name.
 *
 * Usage: node scripts/check-no-skipped-tests.mjs <vitest-json-report>
 */
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('usage: check-no-skipped-tests.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(await readFile(file, 'utf8'));
} catch (err) {
  console.error(`✗ cannot read the vitest report at ${file}: ${err.message}`);
  console.error('  (did the test run crash before writing it?)');
  process.exit(1);
}

const skipped = [];
let ran = 0;
for (const suite of report.testResults ?? []) {
  const name = suite.name.replace(/.*\/tests\//, 'tests/');
  for (const t of suite.assertionResults ?? []) {
    if (t.status === 'skipped' || t.status === 'pending') skipped.push({ name, title: t.title });
    else ran += 1;
  }
}

if (skipped.length > 0) {
  const byFile = new Map();
  for (const s of skipped) byFile.set(s.name, (byFile.get(s.name) ?? 0) + 1);
  console.error(`✗ ${skipped.length} test(s) were SKIPPED — they must run here:\n`);
  for (const [name, n] of [...byFile].sort()) console.error(`    ${name.padEnd(50)} ${n} skipped`);
  console.error('\n  A DB-backed suite skips when WA_TEST_DATABASE_URL is unset or empty.');
  console.error('  In CI it must point at the seeded Postgres service.');
  process.exit(1);
}

console.log(`✓ no skipped tests — all ${ran} ran`);
