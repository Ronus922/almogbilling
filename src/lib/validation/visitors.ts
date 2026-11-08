import { z } from 'zod';
import { DOCUMENT_TYPES } from '@/lib/visitors/model';

// Bodies of the visitor-scan routes. A phone/room/chip is FREE TEXT by decision
// (Ronen, 08/11/2026) — only trimmed and length-capped, never reshaped.

/** '' → null, so an emptied field clears the column instead of storing a blank. */
const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .refine(noNul, 'תו לא חוקי')
    .nullish()
    .transform((v) => (v == null || v === '' ? null : v));

/** `YYYY-MM-DD`, a real calendar day, 1900 → today. '' / null = unknown. */
const dateOfBirth = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v == null || v === '' ? null : v))
  .refine((v) => v === null || isRealPastDate(v), 'תאריך לידה לא תקין');

/** `YYYY-MM-DD` that is a real calendar day (2026-02-31 is not). */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isRealPastDate(v: string): boolean {
  if (!isRealDate(v)) return false;
  return Number(v.slice(0, 4)) >= 1900 && Date.parse(`${v}T00:00:00Z`) <= Date.now();
}

/** Postgres text cannot hold U+0000 — it would be a 500 instead of a 400. */
const noNul = (v: string) => !v.includes('\u0000');

const fieldShape = {
  document_type: z.enum(DOCUMENT_TYPES, 'סוג המסמך לא תקין'),
  document_number: z.string().trim().min(1, 'חסר מספר מסמך').max(40, 'מספר מסמך ארוך מדי').refine(noNul, 'תו לא חוקי'),
  first_name: z.string().trim().min(1, 'חסר שם פרטי').max(80, 'שם פרטי ארוך מדי').refine(noNul, 'תו לא חוקי'),
  last_name: z.string().trim().min(1, 'חסר שם משפחה').max(80, 'שם משפחה ארוך מדי').refine(noNul, 'תו לא חוקי'),
  date_of_birth: dateOfBirth,
  nationality: optionalText(60, 'הלאום ארוך מדי'),
  phone: optionalText(30, 'הטלפון ארוך מדי'),
  room_number: optionalText(20, 'מספר החדר ארוך מדי'),
  chip_number: optionalText(40, 'מספר הצ׳יפ ארוך מדי'),
  notes: optionalText(2000, 'ההערות ארוכות מדי (עד 2000 תווים)'),
};

/** POST /api/visitors — the `data` JSON of the multipart body. */
export const visitorCreateSchema = z.object(fieldShape);

/** PATCH /api/visitors/[id], admin / super admin — any subset, no unknown keys. */
export const visitorUpdateSchema = z.object(fieldShape).partial().strict();

/** PATCH, guard — the notes and nothing else (the route checks the keys first). */
export const visitorNotesSchema = z.object({ notes: fieldShape.notes }).strict();

/** GET /api/visitors query string. */
export const visitorListQuerySchema = z.object({
  q: z.string().trim().max(100).refine(noNul).optional().default(''),
  from: z.string().refine(isRealDate).optional(),
  to: z.string().refine(isRealDate).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
});

/** POST /api/account/password. */
export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'חסרה הסיסמה הנוכחית').max(200),
  new_password: z.string().min(1, 'חסרה סיסמה חדשה').max(200),
});

export type VisitorCreateInput = z.infer<typeof visitorCreateSchema>;

/** The keys of a raw PATCH body, to decide a guard's 403 before any parsing. */
export function bodyKeys(raw: unknown): string[] {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [];
}
