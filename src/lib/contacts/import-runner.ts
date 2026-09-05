import 'server-only';
import { readFile, unlink } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { toArrayBuffer, worksheetToMatrix } from '@/lib/excel/workbook';
import { query, queryOne } from '@/lib/db';
import { upsertContactAndLinkDebtor } from '@/lib/db/contacts';
import type { ContactWritableFields } from '@/lib/types/contacts';
import { logger } from '@/lib/logger';

const BATCH_SIZE = 50;
const BATCH_THROTTLE_MS = 50;
const PROGRESS_EVERY = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The ONLY columns this import owns. Track A's upsert drops everything else, so
// manual fields (notes, tags, address, resident_type, operator_id, primary
// flags) are never touched by an import. Exactly the 7 spec'd fields.
const IMPORT_ALLOWED_FIELDS = [
  'apartment_number',
  'owner_name',
  'owner_phone',
  'owner_email',
  'tenant_name',
  'tenant_phone',
  'tenant_email',
];

export interface ContactsImportRun {
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

export async function createContactsImportRun(fileName: string, userId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.import_runs (kind, mode, status, file_name, initiated_by)
     values ('contacts', 'merge', 'running', $1, $2)
     returning id`,
    [fileName, userId],
  );
  if (!row) throw new Error('Failed to create contacts import_run');
  return row.id;
}

export async function getContactsImportRun(runId: string): Promise<ContactsImportRun | null> {
  return queryOne<ContactsImportRun>(
    `select ${RUN_COLUMNS} from public.import_runs where id = $1 and kind = 'contacts'`,
    [runId],
  );
}

export async function listContactsImportRuns(limit = 10): Promise<ContactsImportRun[]> {
  const r = await query<ContactsImportRun>(
    `select ${RUN_COLUMNS} from public.import_runs
     where kind = 'contacts' order by started_at desc limit $1`,
    [limit],
  );
  return r.rows;
}

// ── parse helpers ─────────────────────────────────────────────────────────

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** All-zeros placeholders ('000000000', spaced/longer variants) → null. */
function normalizePhone(v: unknown): string | null {
  const s = toText(v);
  if (s === null) return null;
  if (/^0+$/.test(s.replace(/\s/g, ''))) return null;
  return s;
}

interface FailedRow {
  row: number;
  apartment_number?: string;
  error: string;
}

// ── the runner ────────────────────────────────────────────────────────────

/**
 * Parse a residents Excel and upsert each row into contacts. Never throws —
 * all outcomes are recorded on the import_runs row. Deletes the temp file when
 * done. Column map (header row 1, data from row 2):
 *   A apartment_number(req) · B owner_name · C owner_phone · D owner_email
 *   E tenant_name · F tenant_phone · G tenant_email · H monthly payment (IGNORED)
 */
export async function runContactsImport(runId: string, filePath: string): Promise<void> {
  try {
    await query(`update public.import_runs set status = 'parsing' where id = $1`, [runId]);

    const buf = await readFile(filePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(toArrayBuffer(buf));
    const sheet = workbook.worksheets[0];
    // header:1 (array of arrays) · range:1 (skip header) · defval:null · blankrows:false
    const matrix: unknown[][] = sheet ? worksheetToMatrix(sheet) : [];

    const total = matrix.length;
    await query(`update public.import_runs set total_rows = $2 where id = $1`, [runId, total]);
    await query(`update public.import_runs set status = 'processing' where id = $1`, [runId]);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const failedRows: FailedRow[] = [];

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = matrix.slice(i, i + BATCH_SIZE);
      for (let j = 0; j < batch.length; j++) {
        const globalIdx = i + j;
        const excelRow = globalIdx + 2; // header is row 1
        const r = batch[j];

        const apartment_number = toText(r[0]);
        if (!apartment_number) {
          skipped++;
        } else {
          // Column H (r[7], monthly payment) is intentionally NOT read.
          const payload: Partial<ContactWritableFields> & { apartment_number: string } = {
            apartment_number,
          };
          const ownerName = toText(r[1]);
          if (ownerName !== null) payload.owner_name = ownerName;
          const ownerPhone = normalizePhone(r[2]);
          if (ownerPhone !== null) payload.owner_phone = ownerPhone;
          const ownerEmail = toText(r[3]);
          if (ownerEmail !== null) payload.owner_email = ownerEmail;
          const tenantName = toText(r[4]);
          if (tenantName !== null) payload.tenant_name = tenantName;
          const tenantPhone = normalizePhone(r[5]);
          if (tenantPhone !== null) payload.tenant_phone = tenantPhone;
          const tenantEmail = toText(r[6]);
          if (tenantEmail !== null) payload.tenant_email = tenantEmail;

          try {
            const { created: wasCreated } = await upsertContactAndLinkDebtor(payload, {
              allowedFields: IMPORT_ALLOWED_FIELDS,
            });
            if (wasCreated) created++;
            else updated++;
          } catch (e) {
            failed++;
            const msg = e instanceof Error ? e.message : String(e);
            failedRows.push({ row: excelRow, apartment_number, error: msg.slice(0, 200) });
          }
        }

        if ((globalIdx + 1) % PROGRESS_EVERY === 0) {
          await query(`update public.import_runs set processed_rows = $2 where id = $1`, [
            runId,
            globalIdx + 1,
          ]);
        }
      }
      if (i + BATCH_SIZE < total) await sleep(BATCH_THROTTLE_MS);
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
    logger.error('[contacts-import:error]', runId, msg);
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
