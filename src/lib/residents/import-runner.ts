import 'server-only';
import { readFile, unlink } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { toArrayBuffer, worksheetToMatrix } from '@/lib/excel/workbook';
import { query, queryOne } from '@/lib/db';
import { upsertContactAndLinkDebtor } from '@/lib/db/contacts';
import type { ContactWritableFields } from '@/lib/types/contacts';
import { validatePhone } from '@/lib/validation';

const BATCH_SIZE = 50;
const BATCH_THROTTLE_MS = 50;
const PROGRESS_EVERY = 25;
const RESIDENT_COLS = 4; // A apartment · B name · C phone · D role

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The ONLY columns this import owns. The upsert drops everything else, so
// manual fields (notes, tags, address, resident_type, emails, primary flags)
// are never touched by a residents import.
const IMPORT_ALLOWED_FIELDS = [
  'apartment_number',
  'owner_name',
  'owner_phone',
  'tenant_name',
  'tenant_phone',
  'operator_name',
  'operator_phone',
];

export interface ResidentsImportRun {
  id: string;
  status: string;
  file_name: string | null;
  total_rows: number;
  processed_rows: number;
  created_rows: number;
  updated_rows: number;
  skipped_rows: number;
  failed_rows: number;
  started_at: Date;
  finished_at: Date | null;
  error_message: string | null;
  error_details: Array<{ row: number; apartment_number?: string; error: string }> | null;
}

const RUN_COLUMNS = `
  id, status, file_name, total_rows, processed_rows,
  created_rows, updated_rows, skipped_rows, failed_rows,
  started_at, finished_at, error_message, error_details`;

// ── DB helpers (used by the 3 import routes) ──────────────────────────────

export async function createResidentsImportRun(fileName: string, userId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.import_runs (kind, mode, status, file_name, initiated_by)
     values ('residents', 'merge', 'running', $1, $2)
     returning id`,
    [fileName, userId],
  );
  if (!row) throw new Error('Failed to create residents import_run');
  return row.id;
}

export async function getResidentsImportRun(runId: string): Promise<ResidentsImportRun | null> {
  return queryOne<ResidentsImportRun>(
    `select ${RUN_COLUMNS} from public.import_runs where id = $1 and kind = 'residents'`,
    [runId],
  );
}

export async function listResidentsImportRuns(limit = 10): Promise<ResidentsImportRun[]> {
  const r = await query<ResidentsImportRun>(
    `select ${RUN_COLUMNS} from public.import_runs
     where kind = 'residents' order by started_at desc limit $1`,
    [limit],
  );
  return r.rows;
}

// ── pure helpers (exported for unit tests — no DB needed) ─────────────────

export type ResidentRole = 'owner' | 'tenant' | 'operator';

/** Hebrew label per role — used in the duplicate-row error message. */
export const ROLE_LABELS: Record<ResidentRole, string> = {
  owner: 'בעל דירה',
  tenant: 'שוכר',
  operator: 'מפעיל',
};

export type ResidentFieldKey =
  | 'owner_name'
  | 'owner_phone'
  | 'tenant_name'
  | 'tenant_phone'
  | 'operator_name'
  | 'operator_phone';

export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Column D (Hebrew role) → role. Substring match so inflections work
 * ('בעלים', 'בעל דירה', 'שוכרת'). Empty → owner. Unrecognized → null
 * (the row then FAILS — see parseResidentRow).
 */
export function mapResidentRole(raw: string | null): ResidentRole | null {
  if (raw === null || raw.trim() === '') return 'owner';
  if (raw.includes('בעל')) return 'owner';
  if (raw.includes('שוכר')) return 'tenant';
  if (raw.includes('מפעיל')) return 'operator';
  return null;
}

export type ParsedResidentRow =
  | { kind: 'skipped' }
  | { kind: 'failed'; apartment_number: string; error: string }
  | {
      kind: 'ok';
      apartment_number: string;
      role: ResidentRole;
      name: string | null;
      phone: string | null;
    };

/**
 * Validate/normalize one data row (0-indexed cells A..D). Outcomes:
 *  - empty apartment (A)                → skipped
 *  - unrecognized non-empty role (D)    → failed 'תפקיד לא מזוהה: <value>'
 *  - neither name (B) nor phone (C)     → skipped
 *  - non-empty invalid phone (C)        → failed with validatePhone's Hebrew error
 *  - otherwise                          → ok (phone normalized; empty cells stay null)
 */
export function parseResidentRow(r: unknown[]): ParsedResidentRow {
  const apartment_number = toText(r[0]);
  if (!apartment_number) return { kind: 'skipped' };

  const roleRaw = toText(r[3]);
  const role = mapResidentRole(roleRaw);
  if (role === null) {
    return { kind: 'failed', apartment_number, error: `תפקיד לא מזוהה: ${roleRaw}` };
  }

  const name = toText(r[1]);
  const phoneRaw = toText(r[2]);
  if (name === null && phoneRaw === null) return { kind: 'skipped' };

  let phone: string | null = null;
  if (phoneRaw !== null) {
    const v = validatePhone(phoneRaw);
    if (!v.valid) {
      return { kind: 'failed', apartment_number, error: v.error ?? 'מספר טלפון לא תקין' };
    }
    phone = v.normalized;
  }

  return { kind: 'ok', apartment_number, role, name, phone };
}

/**
 * Canonical apartment key for grouping/dup detection: trim, strip non-digits,
 * strip leading zeros, '' → '0'. Mirrors the DB layer's
 * normalizeApartmentNumber so '5', '05' and 'דירה 5' collapse to one group
 * (and therefore ONE upsert).
 */
export function normalizeApartmentKey(raw: string): string {
  const digits = (raw ?? '').trim().replace(/\D/g, '').replace(/^0+/, '');
  return digits === '' ? '0' : digits;
}

interface FailedRow {
  row: number;
  apartment_number?: string;
  error: string;
}

export interface ApartmentGroup {
  /** First-seen raw apartment value (the upsert normalizes it again). */
  apartment_number: string;
  fields: Partial<Record<ResidentFieldKey, string>>;
  /** Excel row numbers (header = row 1) of the rows that contributed fields. */
  rows: number[];
}

export interface ResidentsAggregation {
  groups: ApartmentGroup[];
  failedRows: FailedRow[];
  skipped: number;
}

/**
 * Parse every data row, then group per apartment accumulating role fields.
 * First occurrence of an (apartment, role) pair wins — a duplicate FAILS and
 * contributes nothing. A row that failed validation contributes nothing either
 * (no phantom), but other valid rows of the same apartment still apply.
 */
export function aggregateResidentRows(matrix: unknown[][]): ResidentsAggregation {
  const byApt = new Map<string, ApartmentGroup & { roles: Set<ResidentRole> }>();
  const failedRows: FailedRow[] = [];
  let skipped = 0;

  for (let i = 0; i < matrix.length; i++) {
    const excelRow = i + 2; // header is row 1
    const parsed = parseResidentRow(matrix[i]);

    if (parsed.kind === 'skipped') {
      skipped++;
      continue;
    }
    if (parsed.kind === 'failed') {
      failedRows.push({
        row: excelRow,
        apartment_number: parsed.apartment_number,
        error: parsed.error,
      });
      continue;
    }

    const key = normalizeApartmentKey(parsed.apartment_number);
    let group = byApt.get(key);
    if (!group) {
      group = { apartment_number: parsed.apartment_number, fields: {}, rows: [], roles: new Set() };
      byApt.set(key, group);
    }

    if (group.roles.has(parsed.role)) {
      failedRows.push({
        row: excelRow,
        apartment_number: parsed.apartment_number,
        error: `דירה ${parsed.apartment_number} עם תפקיד ${ROLE_LABELS[parsed.role]} מופיעה יותר מפעם אחת בקובץ`,
      });
      continue;
    }

    group.roles.add(parsed.role);
    if (parsed.name !== null) group.fields[`${parsed.role}_name`] = parsed.name;
    if (parsed.phone !== null) group.fields[`${parsed.role}_phone`] = parsed.phone;
    group.rows.push(excelRow);
  }

  return {
    groups: [...byApt.values()].map(({ apartment_number, fields, rows }) => ({
      apartment_number,
      fields,
      rows,
    })),
    failedRows,
    skipped,
  };
}

// ── the runner ────────────────────────────────────────────────────────────

/**
 * Parse a row-per-person residents Excel and merge each apartment into
 * contacts. Never throws — all outcomes are recorded on the import_runs row.
 * Deletes the temp file when done. Column map (header row 1, data from row 2):
 *   A apartment_number(req) · B name · C phone · D role (Hebrew; empty → owner)
 * Merge-only: a non-empty file value overwrites, an empty cell never clears.
 */
export async function runResidentsImport(runId: string, filePath: string): Promise<void> {
  try {
    await query(`update public.import_runs set status = 'parsing' where id = $1`, [runId]);

    const buf = await readFile(filePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(toArrayBuffer(buf));
    const sheet = workbook.worksheets[0];
    // header:1 (array of arrays) · range:1 (skip header) · defval:null · blankrows:false
    const matrix: unknown[][] = sheet ? worksheetToMatrix(sheet, RESIDENT_COLS) : [];

    const total = matrix.length;
    await query(`update public.import_runs set total_rows = $2 where id = $1`, [runId, total]);
    await query(`update public.import_runs set status = 'processing' where id = $1`, [runId]);

    const { groups, failedRows, skipped } = aggregateResidentRows(matrix);
    let created = 0;
    let updated = 0;
    let failed = failedRows.length;
    // Rows resolved during the parse pass (skipped + failed) count as processed
    // up-front; each apartment's contributing rows are added as it is upserted.
    let rowsProcessed = total - groups.reduce((sum, g) => sum + g.rows.length, 0);

    for (let i = 0; i < groups.length; i += BATCH_SIZE) {
      const batch = groups.slice(i, i + BATCH_SIZE);
      for (let j = 0; j < batch.length; j++) {
        const globalIdx = i + j;
        const g = batch[j];

        const payload: Partial<ContactWritableFields> & { apartment_number: string } = {
          apartment_number: g.apartment_number,
          ...g.fields,
        };

        try {
          const { contact, created: wasCreated } = await upsertContactAndLinkDebtor(payload, {
            allowedFields: IMPORT_ALLOWED_FIELDS,
          });
          // A residents import confirms the apartment: needs_review drops to
          // false; source is stamped only when NULL (i.e. the row the upsert
          // just created — the upsert itself never writes source).
          await query(
            `update public.contacts
                set needs_review = false,
                    source = coalesce(source, 'residents_import')
              where id = $1`,
            [contact.id],
          );
          if (wasCreated) created++;
          else updated++;
        } catch (e) {
          failed += g.rows.length;
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          for (const row of g.rows) {
            failedRows.push({ row, apartment_number: g.apartment_number, error: msg });
          }
        }

        rowsProcessed += g.rows.length;
        if ((globalIdx + 1) % PROGRESS_EVERY === 0) {
          await query(`update public.import_runs set processed_rows = $2 where id = $1`, [
            runId,
            rowsProcessed,
          ]);
        }
      }
      if (i + BATCH_SIZE < groups.length) await sleep(BATCH_THROTTLE_MS);
    }

    const finalStatus =
      failed > 0 && created + updated === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed';

    await query(
      `update public.import_runs set
         status = $2, finished_at = now(), processed_rows = $3,
         created_rows = $4, updated_rows = $5, skipped_rows = $6, failed_rows = $7,
         error_details = $8::jsonb
       where id = $1`,
      [
        runId,
        finalStatus,
        total,
        created,
        updated,
        skipped,
        failed,
        JSON.stringify(failedRows.slice(0, 50)),
      ],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[residents-import:error]', runId, msg);
    await query(
      `update public.import_runs set status = 'failed', finished_at = now(), error_message = $2 where id = $1`,
      [runId, msg.slice(0, 1000)],
    );
  } finally {
    await unlink(filePath).catch(() => {
      /* temp file may already be gone — ignore */
    });
  }
}
