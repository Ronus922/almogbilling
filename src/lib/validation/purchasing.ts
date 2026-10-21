import { z } from 'zod';
import { PURCHASING_LIMITS as L } from '@/lib/purchasing/model';

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

export const createRfqBodySchema = z.object({
  doc_date: isoDate,
  title: z.string().trim().min(1, 'יש להזין כותרת').max(L.titleMax, 'הכותרת ארוכה מדי'),
  due_date: isoDate,
  notes: z.string().trim().max(L.notesMax, 'ההערות ארוכות מדי').default(''),
  start_number: startNumber,
  lines: lines.refine((ls) => ls.every((l) => l.unit_price === null), 'בקשה להצעת מחיר אינה כוללת מחירים'),
});

export const createPoBodySchema = z.object({
  doc_date: isoDate,
  title: z.string().trim().max(L.titleMax, 'הכותרת ארוכה מדי').default(''),
  supplier_id: uuid,
  notes: z.string().trim().max(L.notesMax, 'ההערות ארוכות מדי').default(''),
  source_rfq_id: uuid.nullable().default(null),
  start_number: startNumber,
  lines: lines.refine((ls) => ls.every((l) => l.unit_price !== null), 'יש להזין מחיר בכל שורה'),
});

export const updateDocumentBodySchema = z.object({
  title: z.string().trim().max(L.titleMax, 'הכותרת ארוכה מדי'),
  supplier_id: uuid.nullable().default(null),
  notes: z.string().trim().max(L.notesMax, 'ההערות ארוכות מדי').default(''),
  due_date: isoDate.nullable().default(null),
  lines: lines.optional(),
});

export const sendBodySchema = z.object({
  supplier_ids: z.array(uuid).min(1, 'יש לבחור ספק אחד לפחות').max(L.maxRecipients, 'יותר מדי ספקים'),
  email: z.boolean().default(false),
  whatsapp: z.boolean().default(false),
}).refine((b) => b.email || b.whatsapp, { message: 'יש לבחור מייל ו/או WhatsApp' });

export const manualQuoteBodySchema = z.object({
  supplier_id: uuid,
  total_amount: money('הסכום').nullable().default(null),
  valid_until: isoDate.nullable().default(null),
  notes: z.string().trim().max(L.quoteNotesMax, 'ההערות ארוכות מדי').default(''),
  prices: z.record(uuid, money('המחיר')).default({}),
}).refine((b) => b.total_amount !== null || Object.keys(b.prices).length > 0, {
  message: 'יש להזין סכום כולל או מחירים לפי שורות',
});

export const publicQuoteBodySchema = z.object({
  valid_until: isoDate.nullable().default(null),
  notes: z.string().trim().max(L.quoteNotesMax, 'ההערות ארוכות מדי').default(''),
  prices: z.record(uuid, money('המחיר')),
});

export const winnerBodySchema = z.object({ supplier_id: uuid.nullable() });
