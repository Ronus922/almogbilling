import type { CellValue, Worksheet } from 'exceljs';

/**
 * Shared ExcelJS helpers for the Excel imports (debtors + contacts).
 *
 * This module is import-safe on the client (it pulls in only ExcelJS *types*,
 * which are erased at build time). Each consumer creates the workbook itself —
 * server readers `import ExcelJS from 'exceljs'` at the top; client readers use
 * a dynamic `import('exceljs')` so ExcelJS is code-split out of the main bundle
 * (mirroring the old `await import('xlsx')` pattern).
 */

/** Hard size cap on an uploaded workbook, enforced before parsing. */
export const MAX_EXCEL_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Normalise a Buffer/ArrayBuffer to a plain ArrayBuffer for ExcelJS's
 * `xlsx.load()`, whose param type (`interface Buffer extends ArrayBuffer`)
 * structurally requires an ArrayBuffer — a Node Buffer (a Uint8Array) is not
 * assignable. Slices to the exact bytes so a pooled/larger backing store is
 * not over-read.
 */
export function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Reduce an ExcelJS cell value to the same raw JS value the old
 * `xlsx` `sheet_to_json` produced: number | string | boolean | null.
 * Handles rich text, formula results, and hyperlinks; empty/error → null.
 */
export function cellToRaw(value: CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value; // number | string | boolean
  if (value instanceof Date) return value;
  const v = value as unknown as Record<string, unknown>;
  if (Array.isArray(v.richText)) {
    return (v.richText as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
  }
  if ('result' in v) return v.result ?? null; // formula / sharedFormula
  if ('text' in v) return v.text ?? null;     // hyperlink
  return null;                                 // error cell, etc.
}

/**
 * Build a row-major matrix from a worksheet that mirrors the old SheetJS call
 * `sheet_to_json(sheet, { header: 1, range: 1, defval: null, blankrows: false })`:
 *   - header row (row 1) is skipped — data starts at row 2;
 *   - fully-blank rows are dropped (`blankrows: false`);
 *   - empty cells become `null` (`defval: null`);
 *   - columns are 0-indexed (A → 0 … H → 7).
 *
 * ExcelJS is 1-indexed for both rows and columns — handled here so callers keep
 * the exact same 0-indexed `r[0..7]` access as before.
 */
export function worksheetToMatrix(ws: Worksheet, cols = 8): unknown[][] {
  const matrix: unknown[][] = [];
  const lastRow = ws.rowCount; // index of the last row that has values
  for (let rn = 2; rn <= lastRow; rn++) {
    const row = ws.getRow(rn);
    if (!row.hasValues) continue; // blankrows: false (skip only a fully-empty row)
    const arr: unknown[] = [];
    for (let c = 1; c <= cols; c++) {
      arr.push(cellToRaw(row.getCell(c).value));
    }
    matrix.push(arr);
  }
  return matrix;
}
