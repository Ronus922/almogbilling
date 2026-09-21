/**
 * zod request-body schemas for the routes covered by the e2e suite and every
 * route under /api/settings. Messages reproduce the Hebrew strings the routes
 * returned before, so the UI copy is unchanged. New routes: add the schema
 * here and read the body with parseJsonBody (src/lib/http/body.ts).
 */
import { z } from 'zod';
import { normalizeLegalContact, type LegalContact } from '@/lib/validation/legalContact';
import { validatePhone } from '@/lib/validation';
import { CHIP_RESIDENT_ROLES } from '@/lib/constants/chips';
import { WHATSAPP_ATTACHMENT_LIMITS, WHATSAPP_MESSAGE_MAX_FILES } from '@/lib/constants/whatsappAttachments';
import { FINANCE_RECEIPT_LIMITS } from '@/lib/constants/finance';
import { isIsoDate, isMonthKey } from '@/lib/finance/period';
import type { ChipHolderUpdate, ChipResidentRole } from '@/lib/types/chips';

// POST /api/auth/login
export const loginBodySchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  remember: z.boolean().optional().default(false),
});

// PUT /api/debtors/:id/legal-status — null clears the status
export const legalStatusBodySchema = z.object({
  status_id: z
    .uuid({ error: (iss) => (iss.input === undefined ? 'missing_status_id' : 'invalid_status_id') })
    .nullable(),
});

// PUT /api/settings/smtp
const GMAIL_RX = /^[^\s@]+@gmail\.com$/i;
export const smtpSettingsBodySchema = z.object({
  fromEmail: z.string({ error: 'חייב להיות חשבון Gmail' }).trim().regex(GMAIL_RX, 'חייב להיות חשבון Gmail'),
  fromName: z
    .string({ error: 'שם השולח חייב להיות באורך 1-50 תווים' })
    .trim()
    .min(1, 'שם השולח חייב להיות באורך 1-50 תווים')
    .max(50, 'שם השולח חייב להיות באורך 1-50 תווים'),
  // App Password: 16 chars once whitespace is removed; omitted/empty = keep the stored one.
  password: z
    .string()
    .optional()
    .transform((v) => (v ?? '').replace(/\s+/g, ''))
    .refine((v) => v === '' || v.length === 16, 'App Password חייב להכיל 16 תווים'),
});

// POST /api/settings/smtp/test
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const smtpTestBodySchema = z.object({
  to: z.string({ error: 'כתובת אימייל לא תקינה' }).trim().regex(EMAIL_RX, 'כתובת אימייל לא תקינה'),
});

// PUT /api/settings/billing — '' / null / missing clears the rate
const FEE_MESSAGE = 'יש להזין מחיר חיובי או להשאיר ריק';
export const billingSettingsBodySchema = z.object({
  managementFeePerSqm: z
    .union([z.null(), z.undefined(), z.literal(''), z.number(), z.string()])
    .transform((raw, ctx): number | null => {
      if (raw === null || raw === undefined || raw === '') return null;
      const n = typeof raw === 'number' ? raw : Number(raw.trim());
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: FEE_MESSAGE });
        return z.NEVER;
      }
      return n;
    }),
});

// PUT /api/settings/legal-contact — the rules live in normalizeLegalContact
// (shared with the client-side panel); zod turns its per-field errors into
// issues with the field as path.
export const legalContactBodySchema = z
  .object({ email: z.unknown().optional(), name: z.unknown().optional() })
  .transform((raw, ctx): LegalContact => {
    const normalized = normalizeLegalContact(raw);
    if (!normalized.ok) {
      for (const [field, message] of Object.entries(normalized.errors)) {
        if (message) ctx.addIssue({ code: 'custom', path: [field], message });
      }
      return z.NEVER;
    }
    return normalized.value;
  });

// POST /api/chips — `updates`: holder-snapshot edits of chips ALREADY saved on
// the contact, applied inside the issue transaction. Only the fields present
// are written; phone is normalized here so the db layer stores one format.
const chipHolderUpdateSchema = z
  .object({
    id: z.uuid({ error: 'invalid_chip_id' }),
    holder_name: z.string().trim().nullable().optional(),
    holder_phone: z.string().trim().nullable().optional(),
    resident_role: z
      .string()
      .refine(
        (v) => (CHIP_RESIDENT_ROLES as readonly string[]).includes(v),
        'invalid_resident_role',
      )
      .optional(),
  })
  .transform((u, ctx): ChipHolderUpdate => {
    const out: ChipHolderUpdate = { id: u.id };
    if (u.holder_name !== undefined) out.holder_name = u.holder_name || null;
    if (u.holder_phone !== undefined) {
      if (!u.holder_phone) {
        out.holder_phone = null;
      } else {
        const v = validatePhone(u.holder_phone);
        if (!v.valid) {
          ctx.addIssue({ code: 'custom', path: ['holder_phone'], message: v.error ?? 'מספר טלפון לא תקין' });
          return z.NEVER;
        }
        out.holder_phone = v.normalized;
      }
    }
    if (u.resident_role !== undefined) out.resident_role = u.resident_role as ChipResidentRole;
    return out;
  });

export const chipHolderUpdatesSchema = z.array(chipHolderUpdateSchema).max(50, 'too_many_updates');

// POST /api/whatsapp/campaigns — `attachment_ids`: staged uploads (upload order
// is the send order). Count is capped here; ownership + total size are checked
// against the rows in the route.
// POST /api/whatsapp/send — `attachment_ids`: files staged through
// /api/whatsapp/messages/attachments, in send order. A single message is capped
// lower than a broadcast (the send is synchronous, inside the request).
export const messageAttachmentIdsSchema = z
  .array(z.uuid({ error: 'מזהה קובץ מצורף לא תקין' }))
  .max(WHATSAPP_MESSAGE_MAX_FILES, `ניתן לצרף עד ${WHATSAPP_MESSAGE_MAX_FILES} קבצים להודעה`)
  .optional()
  .default([]);

export const campaignAttachmentIdsSchema = z
  .array(z.uuid({ error: 'מזהה קובץ מצורף לא תקין' }))
  .max(WHATSAPP_ATTACHMENT_LIMITS.maxFiles, `ניתן לצרף עד ${WHATSAPP_ATTACHMENT_LIMITS.maxFiles} קבצים לתפוצה`)
  .optional()
  .default([]);

// ── Finance module ("שקיפות כספית") ──────────────────────────────────────────

const finKindSchema = z.enum(['income', 'expense'], { error: 'סוג לא תקין' });
const finSectionSchema = z.enum(['operating', 'renovation_fund'], { error: 'חלק לא תקין' });
const finNameSchema = z
  .string({ error: 'שם הסעיף הוא שדה חובה' })
  .trim()
  .min(1, 'שם הסעיף הוא שדה חובה')
  .max(80, 'שם הסעיף ארוך מדי (עד 80 תווים)');

// POST /api/finance/categories
export const financeCategoryBodySchema = z.object({
  kind: finKindSchema,
  name: finNameSchema,
  section: finSectionSchema.default('operating'),
  is_hot_water: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

// PATCH /api/finance/categories/:id — kind is immutable
export const financeCategoryPatchSchema = z
  .object({
    name: finNameSchema.optional(),
    section: finSectionSchema.optional(),
    is_hot_water: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'אין שדות לעדכון');

// PUT /api/finance/categories/order — the full ordered id list of one kind
export const financeCategoryOrderSchema = z.object({
  ids: z.array(z.uuid({ error: 'מזהה סעיף לא תקין' })).min(1, 'רשימה ריקה').max(200, 'רשימה ארוכה מדי'),
});

const finAmountSchema = z
  .number({ error: 'סכום הוא שדה חובה' })
  .positive('הסכום חייב להיות גדול מ-0')
  .max(9_999_999_999, 'הסכום גדול מדי')
  .refine((v) => Math.round(v * 100) / 100 === v, 'עד שתי ספרות אחרי הנקודה');
const finIsoDateSchema = z.string({ error: 'תאריך תשלום הוא שדה חובה' }).refine(isIsoDate, 'תאריך לא תקין');
const finMonthSchema = z.string({ error: 'חודש הוא שדה חובה' }).refine(isMonthKey, 'חודש לא תקין');
const finCategoryIdSchema = z.uuid({ error: 'סעיף הוא שדה חובה' });
const finDocumentIdsSchema = z
  .array(z.uuid({ error: 'מזהה קובץ לא תקין' }))
  .max(FINANCE_RECEIPT_LIMITS.maxFiles, `ניתן לצרף עד ${FINANCE_RECEIPT_LIMITS.maxFiles} קבצים`)
  .default([]);
const finText = (max: number, label: string) => z.string().trim().max(max, `${label} ארוך מדי (עד ${max} תווים)`).default('');

// POST /api/finance/entries · PATCH /api/finance/entries/:id
export const financeEntryBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('expense'),
    category_id: finCategoryIdSchema,
    amount: finAmountSchema,
    payment_date: finIsoDateSchema,
    supplier_id: z.uuid({ error: 'מזהה ספק לא תקין' }).nullable().default(null),
    supplier_name: finText(200, 'שם הספק'),
    invoice_number: finText(100, 'מספר החשבונית'),
    description: finText(500, 'התיאור'),
    internal_note: finText(2000, 'ההערה'),
    document_ids: finDocumentIdsSchema,
  }),
  z.object({
    kind: z.literal('income'),
    category_id: finCategoryIdSchema,
    amount: finAmountSchema,
    month: finMonthSchema,
    description: finText(500, 'התיאור'),
    internal_note: finText(2000, 'ההערה'),
    document_ids: finDocumentIdsSchema,
  }),
], { error: 'סוג לא תקין' });
export type FinanceEntryBody = z.infer<typeof financeEntryBodySchema>;

// PUT /api/finance/settings
export const financeSettingsBodySchema = z.object({
  show_documents_to_residents: z.boolean({ error: 'ערך לא תקין' }),
});
