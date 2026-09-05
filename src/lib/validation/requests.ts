/**
 * zod request-body schemas for the routes covered by the e2e suite and every
 * route under /api/settings. Messages reproduce the Hebrew strings the routes
 * returned before, so the UI copy is unchanged. New routes: add the schema
 * here and read the body with parseJsonBody (src/lib/http/body.ts).
 */
import { z } from 'zod';
import { normalizeLegalContact, type LegalContact } from '@/lib/validation/legalContact';

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
