import { z } from 'zod';
import { MANUAL_KEY_RE, MANUAL_PARTY, PURCHASING_LIMITS as L } from '@/lib/purchasing/model';

// Request-body schemas of the purchasing routes (zod — the project rule: every
// route parses its body through parseJsonBody). Hebrew messages: the screens
// show `error` as is.

const isoDate = z
  .string({ error: 'יש לבחור תאריך' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'תאריך לא תקין')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'תאריך לא תקין');

const money = (label: string) =>
  z
    .number({ error: `${label} לא תקין` })
    .min(0, `${label} לא יכול להיות שלילי`)
    .max(L.maxUnitPrice, `${label} גדול מדי`)
    .refine((v) => Math.round(v * 100) / 100 === v, 'עד שתי ספרות אחרי הנקודה');

const uuid = z.string().uuid('מזהה לא תקין');

export const lineSchema = z.object({
  description: z
    .string({ error: 'יש להזין פירוט' })
    .trim()
    .min(1, 'יש להזין פירוט')
    .max(L.descriptionMax, 'הפירוט ארוך מדי'),
  quantity: z
    .number({ error: 'כמות לא תקינה' })
    .gt(0, 'הכמות חייבת להיות גדולה מ-0')
    .max(L.maxQuantity, 'הכמות גדולה מדי')
    .refine((v) => Math.round(v * 1000) / 1000 === v, 'עד שלוש ספרות אחרי הנקודה'),
  unit_price: money('המחיר').nullable(),
});

const lines = z
  .array(lineSchema)
  .min(1, 'יש להוסיף לפחות שורה אחת')
  .max(L.maxLines, 'יותר מדי שורות');

export const companyBodySchema = z.object({
  name: z.string().trim().min(1, 'יש להזין שם חברה').max(120),
  tax_id: z.string().trim().min(1, 'יש להזין ח.פ.').max(20),
  address: z.string().trim().min(1, 'יש להזין כתובת').max(200),
  phone: z.string().trim().min(1, 'יש להזין טלפון').max(40),
  email: z.string().trim().email('כתובת מייל לא תקינה').max(200),
  website: z.string().trim().max(200).default(''),
  vat_rate: z.number({ error: 'שיעור מע״מ לא תקין' }).min(0, 'שיעור מע״מ לא תקין').max(100, 'שיעור מע״מ לא תקין'),
});

const startNumber = z
  .number({ error: 'מספר התחלתי לא תקין' })
  .int('מספר התחלתי לא תקין')
  .min(1, 'המספר ההתחלתי חייב להיות 1 ומעלה')
  .max(999_999, 'המספר ההתחלתי גדול מדי')
  .nullable()
  .default(null);

// The supplier of a document: one from the list (supplier_id), or a name typed
// by hand with optional phone / e-mail / address that live on the document only.
const optionalText = (max: number, msg: string) =>
  z.string().trim().max(max, msg).default('').transform((v) => (v === '' ? null : v));

const supplierShape = {
  supplier_id: uuid.nullable().default(null),
  supplier_name: optionalText(200, 'שם הספק ארוך מדי'),
  supplier_phone: optionalText(40, 'הטלפון ארוך מדי'),
  supplier_email: z
    .string().trim().max(200, 'המייל ארוך מדי').default('')
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'כתובת מייל לא תקינה')
    .transform((v) => (v === '' ? null : v)),
  supplier_address: optionalText(300, 'הכתובת ארוכה מדי'),
};

// One supplier of a REQUEST: a listed one (supplier_id) or a hand-typed one (a
// form-made `key` + the name and optional phone / e-mail). Hand-typed details
// live on the request's recipient row only, never in `suppliers`.
export const recipientSchema = z.object({
  supplier_id: uuid.nullable().default(null),
  key: z.string().regex(MANUAL_KEY_RE, 'מזהה ספק לא תקין').nullable().default(null),
  name: optionalText(200, 'שם הספק ארוך מדי'),
  phone: optionalText(40, 'הטלפון ארוך מדי'),
  email: supplierShape.supplier_email,
}).refine((r) => (r.supplier_id !== null) !== (r.key !== null), { message: 'ספק הוא מהרשימה או שהוקלד', path: ['key'] })
  .refine((r) => r.supplier_id !== null || r.name !== null, { message: 'יש להזין שם ספק', path: ['name'] });

export const recipientsSchema = z.array(recipientSchema)
  .max(L.maxRecipients, 'יותר מדי ספקים')
  .refine((rs) => new Set(rs.map((r) => r.supplier_id ?? r.key)).size === rs.length, 'ספק מופיע פעמיים');

const sendFlags = {
  send_email: z.boolean().default(false),
  send_whatsapp: z.boolean().default(false),
};

const hasSupplier = (b: { supplier_id: string | null; supplier_name: string | null }) =>
  b.supplier_id !== null || b.supplier_name !== null;
const SUPPLIER_REQUIRED = 'יש לבחור ספק או להקליד שם ספק';
export const RFQ_TITLE_REQUIRED = 'יש להזין נושא לבקשה';

// The ONE form of both documents: date · supplier · description · (rfq: due
// date) · lines · notes. A request's lines may carry a price (optional), a
// purchase order's must.
const formShape = {
  doc_date: isoDate,
  title: z.string().trim().max(L.titleMax, 'התיאור ארוך מדי').default(''),
  notes: z.string().trim().max(L.notesMax, 'ההערות ארוכות מדי').default(''),
  ...supplierShape,
};

export const createBodySchema = z.discriminatedUnion('doc_type', [
  z.object({
    doc_type: z.literal('rfq'),
    doc_date: formShape.doc_date,
    notes: formShape.notes,
    // A request is told apart in the list by its subject: required (a purchase order's is not).
    title: formShape.title.refine((t) => t !== '', RFQ_TITLE_REQUIRED),
    due_date: isoDate,
    start_number: startNumber,
    lines,
    // A request goes to any number of suppliers, chosen on the form itself.
    recipients: recipientsSchema.refine((rs) => rs.length > 0, 'יש לבחור ספק אחד לפחות'),
    ...sendFlags,
  }),
  z.object({
    doc_type: z.literal('po'),
    ...formShape,
    source_rfq_id: uuid.nullable().default(null),
    start_number: startNumber,
    lines: lines.refine((ls) => ls.every((l) => l.unit_price !== null), 'יש להזין מחיר בכל שורה'),
  }),
]).refine((b) => b.doc_type === 'rfq' || hasSupplier(b), { message: SUPPLIER_REQUIRED, path: ['supplier_name'] });

// A DRAFT (saved without a number, POST/PATCH ?mode=draft) is deliberately
// lenient — it is a work in progress: no supplier / due date / lines required,
// prices optional in both documents. It only has to hold SOMETHING. Issuing it
// (PATCH ?mode=issue) goes through createBodySchema, the strict one.
export const draftBodySchema = z.object({
  doc_type: z.enum(['rfq', 'po']),
  ...formShape,
  due_date: isoDate.nullable().default(null),
  source_rfq_id: uuid.nullable().default(null),
  lines: z.array(lineSchema).max(L.maxLines, 'יותר מדי שורות').default([]),
  recipients: recipientsSchema.default([]),
  ...sendFlags,
}).refine((b) => hasSupplier(b) || b.recipients.length > 0 || b.title !== '' || b.lines.length > 0, {
  message: 'אין מה לשמור בטיוטה — מלאו ספק, תיאור או שורה',
  path: ['supplier_name'],
}).refine((b) => b.doc_type !== 'rfq' || b.title !== '', { message: RFQ_TITLE_REQUIRED, path: ['title'] });

// Editing an ISSUED document. A purchase order must keep its supplier (checked by
// the route); a request's suppliers are its recipients and are not edited here.
export const updateDocumentBodySchema = z.object({
  ...formShape,
  due_date: isoDate.nullable().default(null),
  lines: lines.optional(),
});
export const SUPPLIER_REQUIRED_MESSAGE = SUPPLIER_REQUIRED;
export const bodyHasSupplier = hasSupplier;

export const sendBodySchema = z.object({
  // A listed supplier's uuid, 'manual' for a purchase order's hand-typed supplier,
  // or a request's hand-typed supplier key.
  supplier_ids: z.array(z.union([uuid, z.literal(MANUAL_PARTY), z.string().regex(MANUAL_KEY_RE)])).min(1, 'יש לבחור ספק אחד לפחות').max(L.maxRecipients, 'יותר מדי ספקים'),
  email: z.boolean().default(false),
  whatsapp: z.boolean().default(false),
}).refine((b) => b.email || b.whatsapp, { message: 'יש לבחור מייל ו/או WhatsApp' });

// Adding suppliers to an ISSUED, still-open request (POST .../recipients): same item shape as create's recipients.
export const addRecipientsBodySchema = z.object({
  recipients: recipientsSchema.refine((rs) => rs.length > 0, 'יש לבחור ספק אחד לפחות'),
});

export const publicQuoteBodySchema = z.object({
  // How `prices` were typed. The server normalises (never the client).
  price_mode: z.enum(['excl', 'incl']).default('excl'),
  valid_until: isoDate.nullable().default(null),
  notes: z.string().trim().max(L.quoteNotesMax, 'ההערות ארוכות מדי').default(''),
  prices: z.record(uuid, money('המחיר')),
});

// supplier_id: a listed supplier's uuid, a hand-typed supplier's key, or null = clear.
export const winnerBodySchema = z.object({ supplier_id: z.union([uuid, z.string().regex(MANUAL_KEY_RE)]).nullable() });
