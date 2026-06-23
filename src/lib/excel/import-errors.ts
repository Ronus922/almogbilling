/**
 * Single source of truth that turns an Excel-import failure into a clear Hebrew
 * message — for both server error CODES (the routes return e.g. `invalid_file_type`)
 * and thrown parse errors from ExcelJS/JSZip (a non-.xlsx or corrupt file surfaces
 * as "Can't find end of central directory : is this a zip file ?").
 *
 * Used by all three import surfaces — the debtors wizard (Step1Upload client
 * preview + Step3 route POST) and the contacts import panel — so no raw error
 * code and no library string ever reaches the user.
 */

const GENERIC = 'אירעה שגיאה בייבוא. נסה שוב.';
const INVALID_XLSX = 'הקובץ אינו קובץ Excel תקין (.xlsx). ודא שהקובץ לא פגום ונסה שוב.';

const CODE_MESSAGES: Record<string, string> = {
  invalid_file_type: 'פורמט הקובץ אינו נתמך. שמור כ-.xlsx ונסה שוב.',
  file_too_large: 'הקובץ גדול מדי (מקסימום 10MB).',
  file_required: 'לא נבחר קובץ. בחר קובץ .xlsx ונסה שוב.',
  invalid_request: 'הבקשה אינה תקינה. רענן את העמוד ונסה שוב.',
  invalid_password: 'סיסמה שגויה',
  password_required: 'יש להזין סיסמה',
  unauthorized: 'אין לך הרשאה לבצע ייבוא.',
};

/** A server error CODE (or any short token) → Hebrew; unknown → generic Hebrew. */
export function importErrorFromCode(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code)) {
    return CODE_MESSAGES[code];
  }
  return GENERIC;
}

/**
 * A thrown value (ExcelJS/JSZip parse failure, a recorded run error_message, or a
 * network error) → Hebrew. Already-Hebrew messages (our own size-cap / empty-file
 * throws) pass through unchanged; known library/zip failures map to INVALID_XLSX;
 * a bare known code maps via CODE_MESSAGES; everything else → generic Hebrew.
 */
export function importErrorFromThrown(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e ?? '')).trim();
  if (!msg) return GENERIC;
  // exceljs unzips .xlsx via JSZip; a non-.xlsx / corrupt file throws a zip error.
  if (/central directory|is this a zip|end of (data|central)|corrupt|invalid signature|zip/i.test(msg)) {
    return INVALID_XLSX;
  }
  // Our own throws already carry Hebrew — keep them verbatim.
  if (/[֐-׿]/.test(msg)) return msg;
  // A known server code that arrived as a thrown message.
  if (Object.prototype.hasOwnProperty.call(CODE_MESSAGES, msg)) return CODE_MESSAGES[msg];
  return GENERIC;
}
