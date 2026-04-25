import * as XLSX from 'xlsx';

/**
 * Parsed row from the debtors Excel file.
 * Column mapping (row 1 is the header, parsing starts from row 2):
 *   A → apartment_number
 *   B → owner_name
 *   C → phone (raw)
 *   D → total_debt
 *   E → management_fees
 *   F → monthly_debt (text — e.g. "12,11,10")
 *   G → hot_water_debt
 *   H → details
 */
export interface ParsedDebtorRow {
  apartment_number: string;
  owner_name: string | null;
  phone_raw: string | null;
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

export function parseDebtorsWorkbook(buffer: ArrayBuffer | Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], skipped: 0 };
  }
  const sheet = workbook.Sheets[sheetName];
  // header:1 → array of arrays. range:1 → start from second row (skip header).
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    range: 1,
    defval: null,
    blankrows: false,
  });

  const rows: ParsedDebtorRow[] = [];
  let skipped = 0;

  for (const r of matrix) {
    const apt = toText(r[0]);
    if (!apt) {
      skipped++;
      continue;
    }
    rows.push({
      apartment_number: apt,
      owner_name: toText(r[1]),
      phone_raw: toText(r[2]),
      total_debt: toNumber(r[3]),
      management_fees: toNumber(r[4]),
      monthly_debt: toText(r[5]),
      hot_water_debt: toNumber(r[6]),
      details: toText(r[7]),
    });
  }
  return { rows, skipped };
}
