import {
  DOCUMENT_TYPES,
  type DocumentType,
  type OcrFields,
  type OcrField,
  type OcrResponse,
  type VisitorScan,
  OCR_LOW_CONFIDENCE,
} from '@/lib/visitors/model';

// Formatting + form-state helpers for the visitor-scan screen. Pure — the
// components and the unit tests read the same code.

/** `08/11/2026 21:35` in Israel time, from an ISO timestamp. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/** `1990-05-17` → `17/05/1990`. */
export function formatBirthDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export const fullName = (v: Pick<VisitorScan, 'first_name' | 'last_name'>): string =>
  `${v.first_name} ${v.last_name}`.trim();

/** Every text the form holds — strings only, so inputs stay controlled. */
export interface VisitorFormValues {
  document_type: DocumentType | '';
  document_number: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  nationality: string;
  phone: string;
  room_number: string;
  chip_number: string;
  notes: string;
}

export const EMPTY_FORM: VisitorFormValues = {
  document_type: '', document_number: '', first_name: '', last_name: '', date_of_birth: '',
  nationality: '', phone: '', room_number: '', chip_number: '', notes: '',
};

/** The form as the OCR left it (the guard adds phone / room / chip / notes). */
export function formFromOcr(fields: OcrFields): VisitorFormValues {
  return { ...EMPTY_FORM, ...fields };
}

export function formFromScan(v: VisitorScan): VisitorFormValues {
  return {
    document_type: v.document_type,
    document_number: v.document_number,
    first_name: v.first_name,
    last_name: v.last_name,
    date_of_birth: v.date_of_birth ?? '',
    nationality: v.nationality ?? '',
    phone: v.phone ?? '',
    room_number: v.room_number ?? '',
    chip_number: v.chip_number ?? '',
    notes: v.notes ?? '',
  };
}

/** OCR fields that are read and stored but never shown (so never flagged either): a
 *  flag on a field nobody can see would only tell the guard to look for something that
 *  is not there. */
const UNSHOWN_OCR_FIELDS: ReadonlySet<OcrField> = new Set<OcrField>(['nationality']);

/** The OCR fields the model was unsure about (or left empty while sure of nothing) —
 *  among the ones the form shows. */
export function lowConfidenceFields(res: Pick<OcrResponse, 'fields' | 'confidence'>): Set<OcrField> {
  const out = new Set<OcrField>();
  for (const [k, c] of Object.entries(res.confidence) as [OcrField, number][]) {
    if (UNSHOWN_OCR_FIELDS.has(k)) continue;
    if (res.fields[k] !== '' && c < OCR_LOW_CONFIDENCE) out.add(k);
  }
  return out;
}

export type FormErrors = Partial<Record<keyof VisitorFormValues, string>>;

/** What must be filled before a save is offered — the same minimum the server enforces. */
export function validateForm(v: VisitorFormValues): FormErrors {
  const e: FormErrors = {};
  if (!(DOCUMENT_TYPES as readonly string[]).includes(v.document_type)) e.document_type = 'בחר סוג מסמך';
  if (v.document_number.trim() === '') e.document_number = 'חסר מספר מסמך';
  if (v.first_name.trim() === '') e.first_name = 'חסר שם פרטי';
  if (v.last_name.trim() === '') e.last_name = 'חסר שם משפחה';
  return e;
}

/** The JSON the save routes take: blanks go as '' (the server turns them into NULL). */
export function toPayload(v: VisitorFormValues): Record<string, string> {
  return {
    document_type: v.document_type,
    document_number: v.document_number.trim(),
    first_name: v.first_name.trim(),
    last_name: v.last_name.trim(),
    date_of_birth: v.date_of_birth.trim(),
    nationality: v.nationality.trim(),
    phone: v.phone.trim(),
    room_number: v.room_number.trim(),
    chip_number: v.chip_number.trim(),
    notes: v.notes.trim(),
  };
}

/** base64 (no data: prefix) → a Blob of the given media type, for the multipart save. */
export function blobFromBase64(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
