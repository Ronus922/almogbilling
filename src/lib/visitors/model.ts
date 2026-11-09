// The visitor-scan screen's vocabulary — shared by the routes, the DB layer and
// the client. No I/O, no React, no 'server-only': the form and the tests read
// the same constants.

export const DOCUMENT_TYPES = ['id_card', 'driver_license', 'passport'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  id_card: 'תעודת זהות',
  driver_license: 'רישיון נהיגה',
  passport: 'דרכון',
};

export function isDocumentType(v: unknown): v is DocumentType {
  return typeof v === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(v);
}

/** One row as the API hands it to the screen. The photo is a same-origin
 *  proxy path (/api/files/visitor-ids/…) — never a storage URL. */
export interface VisitorScan {
  id: string;
  document_type: DocumentType;
  document_number: string;
  first_name: string;
  last_name: string;
  /** `YYYY-MM-DD`, or null when the document did not show / nobody typed it. */
  date_of_birth: string | null;
  /** Read by the OCR and stored, but shown on no screen (Ronen, 09/11/2026). */
  nationality: string | null;
  phone: string | null;
  room_number: string | null;
  chip_number: string | null;
  notes: string | null;
  image_url: string;
  image_original_name: string | null;
  scanned_by: string | null;
  scanned_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** The columns an admin may change after the save (everything the form shows). */
export const VISITOR_EDITABLE_FIELDS = [
  'document_type', 'document_number', 'first_name', 'last_name', 'date_of_birth',
  'nationality', 'phone', 'room_number', 'chip_number', 'notes',
] as const;
export type VisitorEditableField = (typeof VISITOR_EDITABLE_FIELDS)[number];

export const VISITOR_PAGE_SIZE = 25;

/** A phone photo is 2–8 MB; this is far above it and far below nginx's 120M. */
export const MAX_VISITOR_IMAGE_BYTES = 15 * 1024 * 1024;
/** The longest side the stored / OCR'd photo is shrunk to. */
export const VISITOR_IMAGE_MAX_SIDE = 1600;

/** What the OCR could read. Every value is a string ('' = could not read) so the
 *  form can be pre-filled without null handling; `confidence` is 0–1 per field. */
export const OCR_FIELDS = [
  'document_type', 'document_number', 'first_name', 'last_name', 'date_of_birth', 'nationality',
] as const;
export type OcrField = (typeof OCR_FIELDS)[number];

export interface OcrFields {
  document_type: DocumentType | '';
  document_number: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  nationality: string;
}

/** Below this the form marks the field for a second look. */
export const OCR_LOW_CONFIDENCE = 0.7;

export const EMPTY_OCR_FIELDS: OcrFields = {
  document_type: '', document_number: '', first_name: '', last_name: '', date_of_birth: '', nationality: '',
};

export interface OcrResponse {
  /** false = the OCR could not run or could not read; the guard fills the form by hand. */
  ok: boolean;
  fields: OcrFields;
  confidence: Partial<Record<OcrField, number>>;
  /** The normalised photo (JPEG, ≤1600px, no metadata) as base64 — the same bytes the
   *  save step stores, so the preview matches and HEIC never reaches the browser. */
  image_base64: string;
}

/** Digits of a phone-ish search term, WITHOUT the national prefix (a leading 0 or 972) — so
 *  `0501234567`, `050-123 4567` and `+972 50 123 4567` all find each other, whichever way the
 *  desk wrote the number down. '' when fewer than 3 digits were typed (too loose to filter on). */
export function phoneNeedle(q: string): string {
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3) return '';
  return digits.replace(/^(972|0)/, '');
}
