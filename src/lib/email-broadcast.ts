import 'server-only';
import {
  resolveEmailSelectionRecipients, resolveConsolidatedEmailSelectionRecipients, listSelectionMissingEmail,
} from '@/lib/whatsapp-broadcast';
import {
  interpolateTemplate, interpolateBroadcastTemplate, isDebtMessageTemplate,
  templateUsesApartmentOutsideBlock, resolveConsolidatedName, sortByApartmentNumberAscending,
  toSubjectLine, recipientDisplayName,
} from '@/lib/whatsapp-template';
import type { RecipientInput } from '@/lib/wa-queue/types';
import type { BroadcastDebtFilter, BroadcastRoleSelection, MissingEmailEntry } from '@/types/whatsapp';

// The email channel's recipients for a "selection" broadcast (09/10/2026) —
// the campaign route and the live estimate both call this, the way the
// WhatsApp channel's resolvers serve them. Placeholders go through the SAME
// functions as WhatsApp (interpolateTemplate / interpolateBroadcastTemplate),
// for the body and for the subject alike.

export interface EmailAudienceInput {
  roles: ReadonlyArray<BroadcastRoleSelection>;
  debtFilter: BroadcastDebtFilter | undefined;
  body: string;
  subject: string;
}

/** A debt message by its body OR its subject — either routes it through the
 *  per-apartment consolidation, exactly like a WhatsApp debt message. */
export function isEmailDebtMessage(body: string, subject: string): boolean {
  return isDebtMessageTemplate(body) || isDebtMessageTemplate(subject);
}

export const NO_EMAIL_RECIPIENTS_ERROR = 'לא נמצאו נמענים עם כתובת אימייל';

export type EmailRecipientsResult =
  | { ok: true; recipients: RecipientInput[]; partialDetailCount: number }
  | { ok: false; error: string };

/** One RecipientInput per email address — a free-form message per address, or
 *  a consolidated debt message listing every apartment of that address. */
export async function buildEmailCampaignRecipients(input: EmailAudienceInput): Promise<EmailRecipientsResult> {
  const { roles, debtFilter, body, subject } = input;

  if (isEmailDebtMessage(body, subject)) {
    const consolidated = await resolveConsolidatedEmailSelectionRecipients(roles, debtFilter);
    if (consolidated.length === 0) return { ok: false, error: NO_EMAIL_RECIPIENTS_ERROR };

    // {{apartment}} outside the repeating block (or anywhere in the subject,
    // which has no block) is ambiguous for an address with several
    // apartments — the same whole-campaign block as WhatsApp.
    if (templateUsesApartmentOutsideBlock(body) || templateUsesApartmentOutsideBlock(subject)) {
      const affected = consolidated.filter((r) => r.apartments.length > 1).length;
      if (affected > 0) {
        return {
          ok: false,
          error: `התבנית משתמשת ב-{{apartment}} מחוץ לקטע החוזר, ו-${affected} נמענים מחזיקים יותר מדירה אחת — לא ברור איזו דירה להציג. עטפו את החלק שחוזר לכל דירה ב-{{#apartments}}...{{/apartments}}.`,
        };
      }
    }

    let partialDetailCount = 0;
    const recipients = consolidated.map((r): RecipientInput => {
      const apartments = sortByApartmentNumberAscending(r.apartments);
      const rep = apartments[0];
      const recipient = { name: resolveConsolidatedName(r.rawNames), apartments };
      const rendered = interpolateBroadcastTemplate(body, recipient);
      if (rendered.truncated) partialDetailCount += 1;
      return {
        contactId: rep.contactId,
        debtorId: rep.debtorId,
        phoneIntl: '',
        email: r.email,
        subject: toSubjectLine(interpolateBroadcastTemplate(subject, recipient).text),
        payload: rendered.text,
        recipientName: recipientDisplayName(r.rawNames),
        apartments: apartments.map((a) => ({ contactId: a.contactId, debtorId: a.debtorId })),
      };
    });
    return { ok: true, recipients, partialDetailCount };
  }

  const resolved = await resolveEmailSelectionRecipients(roles, debtFilter);
  if (resolved.length === 0) return { ok: false, error: NO_EMAIL_RECIPIENTS_ERROR };
  const recipients = resolved.map((r): RecipientInput => {
    const debtor = r.kind === 'supplier'
      ? { owner_name: r.name, tenant_name: null, apartment_number: null, total_debt: null, management_fees: null, hot_water_debt: null }
      : r.debtor;
    return {
      contactId: r.kind === 'supplier' ? null : r.contactId,
      debtorId: r.kind === 'supplier' ? null : r.debtorId,
      supplierId: r.kind === 'supplier' ? r.supplierId : null,
      phoneIntl: '',
      email: r.email,
      subject: toSubjectLine(interpolateTemplate(subject, debtor)),
      payload: interpolateTemplate(body, debtor),
      recipientName: recipientDisplayName([r.name]),
    };
  });
  return { ok: true, recipients, partialDetailCount: 0 };
}

export interface EmailAudienceCount {
  /** Emails that will go out — one per address. */
  count: number;
  /** Debt message: recipients whose apartment list is cut short. */
  partialCount: number;
  /** Who in the audience has no usable address (not sent to). */
  missing: MissingEmailEntry[];
}

/** The compose screen's live estimate for the email channel. */
export async function countEmailAudience(input: EmailAudienceInput): Promise<EmailAudienceCount> {
  const { roles, debtFilter, body, subject } = input;
  const missing = await listSelectionMissingEmail(roles, debtFilter);
  if (isEmailDebtMessage(body, subject)) {
    const consolidated = await resolveConsolidatedEmailSelectionRecipients(roles, debtFilter);
    const partialCount = consolidated.reduce((n, r) => (
      interpolateBroadcastTemplate(body, { name: resolveConsolidatedName(r.rawNames), apartments: r.apartments }).truncated ? n + 1 : n
    ), 0);
    return { count: consolidated.length, partialCount, missing };
  }
  const resolved = await resolveEmailSelectionRecipients(roles, debtFilter);
  return { count: resolved.length, partialCount: 0, missing };
}
