// Documents module constants — server-enforced upload validation.
//
// Allowlist mirrors the suppliers module (images + PDF + Office) and adds plain
// text / CSV, since the generic store accepts more document kinds. Size cap is
// raised to 25MB (suppliers caps at 10MB) — generic documents (scans, reports)
// run larger. Both are enforced server-side in the upload route.

export const ALLOWED_DOC_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
];

export const MAX_DOC_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// Field length caps (server-validated).
export const MAX_FOLDER_NAME_LEN = 200;
export const MAX_FILE_NAME_LEN = 300;
export const MAX_ENTITY_TYPE_LEN = 100;
export const MAX_ENTITY_ID_LEN = 255;
