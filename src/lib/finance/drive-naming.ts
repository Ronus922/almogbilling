// Pure naming rules of the Google Drive backup — no I/O, testable in vitest.
import { FINANCE_DRIVE_ROOT_FOLDER } from '@/lib/constants/finance';
import { monthFolderParts } from './period';

/** Drive's `q` grammar quotes with single quotes and escapes with backslash. */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** `["ALMOG — קבלות", "2026", "09"]` for a 'YYYY-MM-DD' or 'YYYY-MM' string. */
export function driveFolderPath(dateOrMonth: string): [string, string, string] {
  const { year, month } = monthFolderParts(dateOrMonth);
  return [FINANCE_DRIVE_ROOT_FOLDER, year, month];
}

const amountFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** "2026-09-15 — חשמל — ₪1,234.5 — invoice.pdf". Slashes and control
 *  characters cannot appear in a Drive name; the rest (Hebrew included) can. */
export function driveFileName(input: { date: string; category: string; amount: number; originalName: string }): string {
  const clean = (s: string) => s.replace(/[\/\\\u0000-\u001f]/g, '-').trim();
  const name = `${input.date} — ${clean(input.category)} — ₪${amountFmt.format(input.amount)} — ${clean(input.originalName)}`;
  return name.length > 200 ? name.slice(0, 200) : name;
}
