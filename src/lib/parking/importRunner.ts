import 'server-only';
import ExcelJS from 'exceljs';
import { withTransaction } from '@/lib/db';
import { MAX_EXCEL_BYTES, toArrayBuffer, worksheetToMatrix } from '@/lib/excel/workbook';
import { DEFAULT_LOT_CODE } from '@/lib/constants/parking';
import { mapImportRow, type ImportRowError, type MappedImportRow } from './importMapping';

// Excel import for parking spots. Two-step by design: the caller previews, sees
// exactly what would change, and only then commits. Nothing is written during a
// preview.
//
// MODE: append only. "Append" here means upsert by (lot_code, spot_number) — a
// spot already in the table is updated, one that is missing is inserted, and
// anything NOT in the file is left completely alone. A replace mode (which would
// have to deactivate the spots absent from the file) is deliberately absent: it
// can silently unassign the whole lot from one mistaken upload, and needs its
// own confirmation design before it exists.

export interface ImportPreview {
  toInsert: number;
  toUpdate: number;
  errors: ImportRowError[];
  /** Rows that parsed but collide with another row IN THE SAME FILE. */
  duplicateSpotNumbers: number[];
  /** Apartment numbers referenced by the file that do not exist in contacts. */
  unknownApartments: string[];
  totalRows: number;
}

export interface ImportResult extends ImportPreview {
  inserted: number;
  updated: number;
}

async function parseWorkbook(buffer: ArrayBuffer | Buffer): Promise<{
  rows: MappedImportRow[]; errors: ImportRowError[]; totalRows: number;
}> {
  const byteLen = buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.length;
  if (byteLen > MAX_EXCEL_BYTES) {
    throw new Error(`קובץ גדול מדי (מקסימום ${Math.floor(MAX_EXCEL_BYTES / 1024 / 1024)}MB)`);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(buffer));
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('הקובץ אינו מכיל גיליון נתונים');

  // Three columns: מספר חניה | דירה | הערה. worksheetToMatrix skips the header
  // row and drops fully-blank rows, so index 0 here is worksheet row 2.
  const matrix = worksheetToMatrix(sheet, 3);

  const rows: MappedImportRow[] = [];
  const errors: ImportRowError[] = [];
  matrix.forEach((r, i) => {
    const result = mapImportRow(r[0], r[1], r[2], i + 2);
    if (result.ok) rows.push(result.row);
    else errors.push(result.error);
  });
  return { rows, errors, totalRows: matrix.length };
}

/**
 * Read the file and report what committing it WOULD do. Runs every check the
 * commit runs, so a clean preview means a commit that will not fail halfway.
 */
export async function previewParkingImport(
  buffer: ArrayBuffer | Buffer,
  lotCode: string = DEFAULT_LOT_CODE,
): Promise<ImportPreview> {
  const { rows, errors, totalRows } = await parseWorkbook(buffer);

  // Collisions within the file itself — two lines claiming one spot number.
  // Caught here because the DB would only report the second one, as a bare
  // unique violation with no line number attached.
  const seen = new Set<number>();
  const duplicateSpotNumbers: number[] = [];
  for (const r of rows) {
    if (seen.has(r.spot_number)) duplicateSpotNumbers.push(r.spot_number);
    else seen.add(r.spot_number);
  }

  return withTransaction(async (client) => {
    const spotNumbers = [...seen];
    const existing = spotNumbers.length
      ? (await client.query<{ spot_number: number }>(
          `select spot_number from public.parking_spots
            where lot_code = $1 and spot_number = any($2::int[])`,
          [lotCode, spotNumbers],
        )).rows.map((x) => x.spot_number)
      : [];
    const existingSet = new Set(existing);

    const apartments = [...new Set(
      rows.filter((r) => r.apartment_number).map((r) => r.apartment_number as string),
    )];
    const known = apartments.length
      ? (await client.query<{ apartment_number: string }>(
          `select apartment_number from public.contacts
            where apartment_number = any($1::text[])`,
          [apartments],
        )).rows.map((x) => x.apartment_number)
      : [];
    const knownSet = new Set(known);
    const unknownApartments = apartments.filter((a) => !knownSet.has(a));

    let toInsert = 0;
    let toUpdate = 0;
    for (const n of seen) {
      if (existingSet.has(n)) toUpdate++;
      else toInsert++;
    }

    return { toInsert, toUpdate, errors, duplicateSpotNumbers, unknownApartments, totalRows };
  });
}

/**
 * Commit the file. Refuses outright if anything is wrong — a parse error, a
 * duplicate inside the file, or an apartment with no contacts row. Partial
 * imports are worse than none here: the lot's allocation is read as a whole,
 * and a half-applied file leaves it neither the old state nor the new one.
 */
export async function commitParkingImport(
  buffer: ArrayBuffer | Buffer,
  actorId: string,
  lotCode: string = DEFAULT_LOT_CODE,
): Promise<ImportResult> {
  const preview = await previewParkingImport(buffer, lotCode);
  if (preview.errors.length > 0
    || preview.duplicateSpotNumbers.length > 0
    || preview.unknownApartments.length > 0) {
    return { ...preview, inserted: 0, updated: 0 };
  }

  const { rows } = await parseWorkbook(buffer);

  return withTransaction(async (client) => {
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      // ON CONFLICT on the (lot_code, spot_number) unique constraint — the same
      // constraint that guarantees one row per physical spot. `xmax = 0` is the
      // standard way to tell an INSERT from an UPDATE in a RETURNING clause.
      const res = await client.query<{ inserted: boolean }>(
        `insert into public.parking_spots
           (lot_code, spot_number, size_type, owner_type, apartment_number,
            sale_status, notes, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         on conflict (lot_code, spot_number) do update
            set size_type        = excluded.size_type,
                owner_type       = excluded.owner_type,
                apartment_number = excluded.apartment_number,
                sale_status      = excluded.sale_status,
                notes            = excluded.notes,
                updated_by       = excluded.updated_by
         returning (xmax = 0) as inserted`,
        [lotCode, r.spot_number, r.size_type, r.owner_type, r.apartment_number,
         r.sale_status, r.notes, actorId],
      );
      if (res.rows[0]?.inserted) inserted++;
      else updated++;
    }
    return { ...preview, inserted, updated };
  });
}
