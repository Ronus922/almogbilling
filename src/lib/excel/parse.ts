import ExcelJS from 'exceljs';
import { splitOwnerTenantPhones } from '@/lib/whatsapp';
import { MAX_EXCEL_BYTES, toArrayBuffer, worksheetToMatrix } from '@/lib/excel/workbook';

/**
 * Parsed row from the debtors Excel file.
 * Column mapping (row 1 is the header, parsing starts from row 2):
 *   A → apartment_number
 *   B → owner_name
 *   C → phone (raw) — split into clean local owner/tenant numbers on parse
 *   D → total_debt
 *   E → management_fees
 *   F → monthly_debt (text — e.g. "12,11,10")
 *   G → hot_water_debt
 *   H → details
 *
 * Phone policy: DB fields hold a single clean local number (0XXXXXXXXX). The raw
 * cell may be compound ("054… (בעלים) 050… (שוכר/ת)"), Markdown or tel: — all
 * normalised + split here via the shared splitOwnerTenantPhones().
 */
export interface ParsedDebtorRow {
  apartment_number: string;
  owner_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  total_debt: number;
  management_fees: number;
  monthly_debt: string | null;
  hot_water_debt: number;
  details: string | null;
}

export interface ParseResult {
  rows: ParsedDebtorRow[];
  skipped: number;
}

function toNumber(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  // Strip currency symbol, commas, etc.
  const cleaned = String(v).replace(/[^\d.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

export async function parseDebtorsWorkbook(buffer: ArrayBuffer | Buffer): Promise<ParseResult> {
  const byteLen = buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.length;
  if (byteLen > MAX_EXCEL_BYTES) {
    throw new Error(`קובץ גדול מדי (מקסימום ${Math.floor(MAX_EXCEL_BYTES / 1024 / 1024)}MB)`);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(buffer));
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { rows: [], skipped: 0 };
  }
  // header:1 (array of arrays) · range:1 (skip header) · defval:null · blankrows:false
  const matrix = worksheetToMatrix(sheet);

  const rows: ParsedDebtorRow[] = [];
  let skipped = 0;

  for (const r of matrix) {
    const apt = toText(r[0]);
    if (!apt) {
      skipped++;
      continue;
    }
    const rawPhone = r[2] == null ? null : String(r[2]);
    const phones = splitOwnerTenantPhones(rawPhone);
    rows.push({
      apartment_number: apt,
      owner_name: toText(r[1]),
      phone_owner: phones.owner,
      phone_tenant: phones.tenant,
      total_debt: toNumber(r[3]),
      management_fees: toNumber(r[4]),
      monthly_debt: toText(r[5]),
      hot_water_debt: toNumber(r[6]),
      details: toText(r[7]),
    });
  }
  return { rows, skipped };
}
