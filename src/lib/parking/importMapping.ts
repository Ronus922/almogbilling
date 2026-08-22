// Mapping from the 2015 "הצמדת חניות לדירות" worksheet to parking_spots rows.
//
// Expected columns: מספר חניה | דירה | הערה
//
// The notes column of the source is overloaded: it holds either a small digit
// that ENCODES a property, or free text. The digits are the document's own
// shorthand:
//     2 → the spot is double along its width
//     3 → the spot is double along its length
//     1 → the spot is mid-sale
// A digit is therefore consumed as structure and NOT kept as a note; anything
// else is kept verbatim as the note.
//
// The apartment column is likewise overloaded: it holds an apartment number, or
// one of two owner keywords.
//
// Pure — no exceljs, no DB — so the mapping can be tested without a workbook.

import type {
  ParkingOwnerType, ParkingSaleStatus, ParkingSizeType,
} from '@/lib/types/parking';
import { SPOT_NUMBER_MAX, SPOT_NUMBER_MIN } from '@/lib/constants/parking';

export interface MappedImportRow {
  /** 1-based worksheet row, so an error can name the line the user must fix. */
  rowNumber: number;
  spot_number: number;
  owner_type: ParkingOwnerType;
  apartment_number: string | null;
  sale_status: ParkingSaleStatus;
  size_type: ParkingSizeType;
  notes: string | null;
}

export interface ImportRowError {
  rowNumber: number;
  message: string;
  /** Echoed back so the preview can show the offending line as it was read. */
  raw: { spot: string; apartment: string; note: string };
}

export type MapResult =
  | { ok: true; row: MappedImportRow }
  | { ok: false; error: ImportRowError };

/**
 * Hebrew abbreviations arrive with any of three quote characters depending on
 * who typed them — ASCII ", the gershayim ״, or a smart quote. Normalising is
 * the difference between 36 developer spots and 36 errors.
 */
function normalizeHebrew(v: string): string {
  return v.replace(/[״"“”″]/g, '"').replace(/\s+/g, ' ').trim();
}

const DEVELOPER_TOKENS = new Set(['חו"כ', 'חוף הכרמל', 'חוה"כ']);
const COMMITTEE_TOKENS = new Set(['נציגות', 'ועד', 'נציגות הבית']);

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  return String(v).trim();
}

export function mapImportRow(
  spotRaw: unknown,
  apartmentRaw: unknown,
  noteRaw: unknown,
  rowNumber: number,
): MapResult {
  const spotText = text(spotRaw);
  const apartmentText = text(apartmentRaw);
  const noteText = text(noteRaw);
  const raw = { spot: spotText, apartment: apartmentText, note: noteText };

  if (!spotText) {
    return { ok: false, error: { rowNumber, message: 'שורה ללא מספר חניה', raw } };
  }
  const spot_number = Number(spotText);
  if (!Number.isInteger(spot_number)) {
    return { ok: false, error: { rowNumber, message: `מספר חניה לא תקין: "${spotText}"`, raw } };
  }
  if (spot_number < SPOT_NUMBER_MIN || spot_number > SPOT_NUMBER_MAX) {
    return {
      ok: false,
      error: { rowNumber, message: `מספר חניה מחוץ לטווח: ${spot_number}`, raw },
    };
  }

  // Note column → structure or free text.
  let size_type: ParkingSizeType = 'single';
  let sale_status: ParkingSaleStatus = 'none';
  let notes: string | null = null;
  const noteKey = normalizeHebrew(noteText);
  if (noteKey === '2') size_type = 'double_width';
  else if (noteKey === '3') size_type = 'double_length';
  else if (noteKey === '1') sale_status = 'in_process';
  else if (noteKey) notes = noteText;

  // Apartment column → owner.
  const aptKey = normalizeHebrew(apartmentText);
  let owner_type: ParkingOwnerType;
  let apartment_number: string | null = null;

  if (!aptKey) {
    return {
      ok: false,
      error: { rowNumber, message: 'שורה ללא שיוך — צפוי מספר דירה, "חו״כ" או "נציגות"', raw },
    };
  }
  if (DEVELOPER_TOKENS.has(aptKey)) {
    owner_type = 'developer';
  } else if (COMMITTEE_TOKENS.has(aptKey)) {
    owner_type = 'committee';
    // The document lists committee-held spots precisely because they are the
    // ones still up for sale, so the status travels with the ownership.
    sale_status = 'for_sale';
  } else {
    owner_type = 'apartment';
    apartment_number = apartmentText.trim();
  }

  return {
    ok: true,
    row: { rowNumber, spot_number, owner_type, apartment_number, sale_status, size_type, notes },
  };
}
