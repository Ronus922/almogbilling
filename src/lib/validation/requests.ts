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
import { cleanPhoneField } from '@/lib/whatsapp';
import type { ChipHolderUpdate, ChipResidentRole } from '@/lib/types/chips';
import type { SupplierContactInput } from '@/lib/types/suppliers';

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

// POST /api/suppliers + PATCH /api/suppliers/:id — `additional_contacts`: the
// supplier's 2nd, 3rd… contact people (the primary one stays in the supplier's
// own fields). The panel always sends the whole list. Same rules as the
// supplier's own phone/email: phone cleaned to one canonical local number
// (cleanPhoneField), email format-checked. A fully blank row is dropped.
// Messages are Hebrew — the supplier panels toast the error as-is.
const SUPPLIER_CONTACTS_MAX = 50;
const supplierContactText = z.string({ error: 'איש קשר נוסף לא תקין' }).trim().default('');
const supplierContactSchema = z
  .object(
    {
      name: supplierContactText,
      phone: supplierContactText,
      email: supplierContactText,
    },
    { error: 'איש קשר נוסף לא תקין' },
  )
  .transform((c, ctx): SupplierContactInput | null => {
    if (!c.name && !c.phone && !c.email) return null;
    let phone = '';
    if (c.phone) {
      const cleaned = cleanPhoneField(c.phone);
      if (!cleaned) {
        ctx.addIssue({ code: 'custom', path: ['phone'], message: 'מספר טלפון לא תקין באיש קשר נוסף' });
        return z.NEVER;
      }
      phone = cleaned;
    }
    if (c.email && !EMAIL_RX.test(c.email)) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'כתובת אימייל לא תקינה באיש קשר נוסף' });
      return z.NEVER;
    }
    return { name: c.name, phone, email: c.email };
  });

export const supplierContactsSchema = z
  .array(supplierContactSchema, { error: 'רשימת אנשי הקשר הנוספים לא תקינה' })
  .max(SUPPLIER_CONTACTS_MAX, `ניתן להוסיף עד ${SUPPLIER_CONTACTS_MAX} אנשי קשר נוספים`)
  .transform((rows) => rows.filter((r): r is SupplierContactInput => r !== null));

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

// PATCH /api/finance/categories/:id — kind and section are immutable (the
// section is fixed by the tab the category was created from; a `section` key
// in the body is dropped)
export const financeCategoryPatchSchema = z
  .object({
    name: finNameSchema.optional(),
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
// `section` = which tab the line is entered from; the category MUST belong to
// it (resolveEntryInput) — a fund line can never sit on an operating category.
export const financeEntryBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('expense'),
    section: finSectionSchema.default('operating'),
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
    section: finSectionSchema.default('operating'),
    category_id: finCategoryIdSchema,
    amount: finAmountSchema,
    month: finMonthSchema,
    description: finText(500, 'התיאור'),
    internal_note: finText(2000, 'ההערה'),
    document_ids: finDocumentIdsSchema,
  }),
], { error: 'סוג לא תקין' });
export type FinanceEntryBody = z.infer<typeof financeEntryBodySchema>;

// PUT /api/finance/settings — the residents switches; at least one of them.
export const financeSettingsBodySchema = z
  .object({
    show_documents_to_residents: z.boolean({ error: 'ערך לא תקין' }).optional(),
    show_bank_balance_to_residents: z.boolean({ error: 'ערך לא תקין' }).optional(),
  })
  .refine((v) => v.show_documents_to_residents !== undefined || v.show_bank_balance_to_residents !== undefined, 'אין מה לשמור');

// PUT /api/finance/month-status — publish / hide one month for residents,
// and/or set (null = clear) its hand-entered month-end bank balance.
export const financeMonthStatusBodySchema = z
  .object({
    month: finMonthSchema,
    published: z.boolean({ error: 'ערך לא תקין' }).optional(),
    bank_balance: z
      .number({ error: 'יתרת הבנק חייבת להיות מספר' })
      .min(-9_999_999_999, 'הסכום קטן מדי')
      .max(9_999_999_999, 'הסכום גדול מדי')
      .refine((v) => Math.round(v * 100) / 100 === v, 'עד שתי ספרות אחרי הנקודה')
      .nullable()
      .optional(),
  })
  .refine((v) => v.published !== undefined || v.bank_balance !== undefined, 'אין מה לשמור');

// PUT /api/finance/fund-settings — the renovation fund collection target
export const financeFundSettingsBodySchema = z.object({
  target_amount: z
    .number({ error: 'יעד הגבייה הוא שדה חובה' })
    .min(0, 'היעד לא יכול להיות שלילי')
    .max(9_999_999_999, 'הסכום גדול מדי')
    .refine((v) => Math.round(v * 100) / 100 === v, 'עד שתי ספרות אחרי הנקודה'),
});

// ── Owners portal ("פורטל בעלי דירות") ──────────────────────────────────────
// The phone arrives as the resident typed it (any Israeli format, or a foreign
// number with its '+' and country code); the routes normalise it with
// toPortalE164 (src/lib/portal/phone.ts). The schema only checks that SOMETHING
// plausible was typed — 8 chars is the shortest E.164 ('+' + 7 digits) — telling
// an unregistered number apart from a malformed one is the route's job, and
// both get the same answer.

// POST /api/portal/otp/request
export const portalOtpRequestBodySchema = z.object({
  phone: z
    .string({ error: 'מספר טלפון לא תקין' })
    .trim()
    .min(8, 'מספר טלפון לא תקין')
    .max(20, 'מספר טלפון לא תקין'),
});

// POST /api/portal/otp/verify
export const portalOtpVerifyBodySchema = z.object({
  phone: z
    .string({ error: 'מספר טלפון לא תקין' })
    .trim()
    .min(8, 'מספר טלפון לא תקין')
    .max(20, 'מספר טלפון לא תקין'),
  code: z
    .string({ error: 'הקוד חייב להכיל 6 ספרות' })
    .trim()
    .regex(/^\d{6}$/, 'הקוד חייב להכיל 6 ספרות'),
});

// PATCH /api/apartments/[apartment]/owner-phones — DETACH, the only write the
// admin screen has (decision 5 of the 03/10/2026 audit): a phone reaches the
// portal through the apartment's owner record and nothing else, so there is no
// add, no rename and no re-activation here. `.strict()` rejects any other key.
export const ownerPhoneDetachBodySchema = z
  .object({
    id: z.uuid({ error: 'מזהה לא תקין' }),
    is_active: z.literal(false, { error: 'אפשר רק לנתק שיוך' }),
  })
  .strict();

// POST /api/apartments/[apartment]/portal-unlock
export const portalUnlockBodySchema = z.object({
  phone: z
    .string({ error: 'מספר טלפון לא תקין' })
    .trim()
    .min(8, 'מספר טלפון לא תקין')
    .max(20, 'מספר טלפון לא תקין'),
});

// POST /api/sync/bllink — the body is OPTIONAL: billing-sync.timer posts none at
// all (scripts/run-bllink-sync.sh), so an absent body must read as {} and behave
// exactly as before. `fresh` is the dashboard button asking for a real Bllink
// scrape first, instead of re-copying the morning snapshot.
export const syncBllinkBodySchema = z.object({
  fresh: z.boolean().optional(),
});

// GET /api/contacts/suggestions/replacement?id= — the phones an owner
// replacement would detach, for its confirmation dialog.
export const ownerReplacementQuerySchema = z.object({ id: z.uuid() });

// ── Portal identity (03/10/2026) ─────────────────────────────────────────────
const identityRelationSchema = z.enum(['personal', 'company_authorized', 'family']);
const identityApartmentsSchema = z.array(z.object({
  apartment_number: z.string().trim().min(1).max(20),
  relation: identityRelationSchema,
})).min(1).max(50);
const e164Schema = z.string().regex(/^\+[1-9][0-9]{6,14}$/, { error: 'invalid_phone' });

// POST /api/admin/portal-identity — "אדם אחד", revoking it, turning a request down.
export const portalIdentityActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    phone_e164: e164Schema,
    display_name: z.string().trim().min(1, { error: 'missing_display_name' }).max(120),
    apartments: identityApartmentsSchema,
  }),
  z.object({ action: z.enum(['revoke', 'reject']), id: z.uuid() }),
]);

// The answers to "אותו אדם?" (body key `phone_decisions` of every write under
// the entry warning — lib/http/phoneEntry.ts).
export const phoneEntryDecisionsSchema = z.array(z.object({
  phone_e164: e164Schema,
  decision: z.enum(['same', 'different']),
  identity: z.object({
    display_name: z.string().trim().min(1).max(120),
    apartments: identityApartmentsSchema,
  }).optional(),
})).max(20);

// POST /api/contacts/suggestions — approve or reject Bllink proposals by id.
// The client sends every id it means to resolve, "אשר הכל" included, so the
// server never has to guess what "all" was at the moment of the click.
//   • approve with SEVERAL ids ("אשר הכל") resolves only the suggestions that
//     do not change portal access — a phone, a link, an unlink and an owner
//     change are approved one by one (03/10/2026);
//   • approve_rename / approve_replace decide ONE owner-name suggestion: a
//     name fix, or a new owner whose predecessor's phones are detached;
//   • phone_decisions — the answers to "אותו אדם?" when an approval came back
//     409 phone_conflict (lib/http/phoneEntry.ts).
export const contactSuggestionsResolveSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.enum(['approve', 'reject']),
    ids: z.array(z.uuid()).min(1, { error: 'missing_ids' }).max(500),
    phone_decisions: phoneEntryDecisionsSchema.optional(),
  }),
  z.object({
    action: z.enum(['approve_rename', 'approve_replace']),
    ids: z.array(z.uuid()).length(1, { error: 'one_owner_name_suggestion' }),
    phone_decisions: phoneEntryDecisionsSchema.optional(),
  }),
]);

// PATCH /api/issues/[id]/move — a drop on the issues kanban: the column, and
// the card it now sits directly above (null = the bottom of the column). The
// card itself is the [id]; "בוצע" is not a column here — it is a status, and
// stays the [id] PATCH {status:'closed'}.
export const issueBoardMoveBodySchema = z.object({
  column: z.enum(['awaiting', 'today', 'in_progress'], { error: 'invalid_column' }),
  before_id: z.uuid({ error: 'invalid_before_id' }).nullable(),
});

// PATCH /api/decisions/[id] — the metadata of a decision / protocol. The file
// itself is never replaced (replacing = delete + upload again), so no field
// here touches the object. `published` is sent by the list's switch too, which
// is why it is part of the same schema rather than a route of its own.
export const decisionUpdateBodySchema = z.object({
  title: z.string().trim().min(1, { error: 'יש להזין כותרת' }).max(200),
  summary: z.string().trim().max(2000).nullish().transform((v) => (v ? v : null)),
  doc_type: z.enum(['decision', 'protocol'], { error: 'יש לבחור סוג מסמך' }),
  decision_number: z.string().trim().max(40).nullish().transform((v) => (v ? v : null)),
  decided_at: z.iso.date({ error: 'יש לבחור תאריך החלטה' }),
  published: z.boolean(),
});
