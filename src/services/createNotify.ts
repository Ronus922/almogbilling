import 'server-only';
import { appUrl } from '@/lib/config';
import { getNotificationRecipient } from '@/lib/db/users';
import { getSupplierNotifyContact } from '@/lib/db/suppliers';
import { sendNotificationEmail } from '@/services/email';
import { sendWhatsAppMessage, normalizePhone } from '@/lib/whatsapp';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import { getSignature, signatureWhatsApp } from '@/lib/notify/signature';
import {
  channelFor,
  recipientKey,
  type NotifyChannelSelection,
  type NotifySelection,
} from '@/lib/notify/selection';
import type { AssigneeRef } from '@/lib/types/assignee';
import { logger } from '@/lib/logger';

/**
 * Best-effort fan-out for the create-form notification matrix. Sends ONLY the
 * channels the creator explicitly selected, per recipient. A recipient is a
 * user OR a supplier (multi-assignee, 047). The matrix is an explicit override,
 * so passive per-user opt-in flags are bypassed — the only server gate is the
 * PRESENCE of a contact detail (mirrors the UI cell availability, re-checked
 * here so a tampered payload can't reach a recipient with no email/phone).
 *
 * NEVER throws / never blocks the create — call with `void`. In-app bells are
 * emitted separately and are not touched here.
 */
export type CreateNotifyRecipient =
  | { kind: 'user'; userId: string; selection: NotifyChannelSelection; message: string }
  | { kind: 'supplier'; supplierId: string; selection: NotifyChannelSelection; message: string };

/** Structured entity details rendered on BOTH channels. Empty/null values drop
 *  their row entirely — a missing location must never render as a blank line. */
export interface CreateNotifyDetails {
  description?: string | null;
  /** Resolved location label (apartment number / area name) — target_label. */
  targetLabel?: string | null;
  dueDate?: string | null; // 'YYYY-MM-DD'
  dueTime?: string | null; // 'HH:MM[:SS]'
  /** Creator on create; the editing actor on edit-time assignment. */
  assignedByName?: string | null;
}

/** 'YYYY-MM-DD' (+ optional 'HH:MM[:SS]') → 'DD/MM/YYYY[ HH:MM]'. */
function formatDueDate(date: string, time?: string | null): string {
  const [y, m, d] = date.split('-');
  const base = y && m && d ? `${d}/${m}/${y}` : date;
  return time ? `${base} ${time.slice(0, 5)}` : base;
}

/** Detail rows shared by the email template and the WhatsApp body (also used by
 *  the reminders engine for the same uniform layout). */
export function detailRows(d: CreateNotifyDetails | undefined): { label: string; value: string }[] {
  if (!d) return [];
  const rows: { label: string; value: string }[] = [];
  if (d.description) rows.push({ label: 'תיאור', value: d.description });
  if (d.targetLabel) rows.push({ label: 'מיקום', value: d.targetLabel });
  if (d.dueDate) rows.push({ label: 'תאריך יעד', value: formatDueDate(d.dueDate, d.dueTime) });
  if (d.assignedByName) rows.push({ label: 'הוקצה ע"י', value: d.assignedByName });
  return rows;
}

/** Plain-text block of detail rows for the WhatsApp body ('' when empty). */
export function detailRowsWhatsApp(rows: { label: string; value: string }[]): string {
  return rows.length ? `\n\n${rows.map((r) => `${r.label}: ${r.value}`).join('\n')}` : '';
}

export interface DispatchCreateNotificationsInput {
  /** Email subject / WhatsApp heading. */
  title: string;
  /** Relative deep-link, e.g. `/tasks?task=<id>`. Sent ONLY to registered
   *  users (kind 'user') — it sits behind login, so a supplier gets the full
   *  details in text with no link (public link = separate follow-up slice). */
  actionUrl: string;
  details?: CreateNotifyDetails;
  recipients: CreateNotifyRecipient[];
}

interface ResolvedContact {
  name: string;
  email: string | null;
  phone: string | null;
}

async function resolveContact(r: CreateNotifyRecipient): Promise<ResolvedContact | null> {
  if (r.kind === 'user') {
    const u = await getNotificationRecipient(r.userId);
    if (!u || !u.is_active) return null;
    return { name: u.full_name ?? u.username, email: u.email || null, phone: u.notification_phone };
  }
  const s = await getSupplierNotifyContact(r.supplierId);
  if (!s) return null;
  return { name: s.display_name, email: s.email, phone: s.phone };
}

async function sendToRecipient(
  r: CreateNotifyRecipient,
  input: DispatchCreateNotificationsInput,
): Promise<void> {
  if (!r.selection.email && !r.selection.whatsapp) return;
  const { title } = input;
  const id = r.kind === 'user' ? r.userId : r.supplierId;
  const contact = await resolveContact(r);
  if (!contact) return;

  const rows = detailRows(input.details);
  // The view link sits behind login → registered users only.
  const viewUrl = r.kind === 'user' ? `${appUrl()}${input.actionUrl}` : null;

  if (r.selection.email) {
    if (!contact.email) {
      logger.warn('[createNotify] skipped email — no address', r.kind, id);
    } else {
      try {
        await sendNotificationEmail(contact.email, {
          recipientName: contact.name,
          title,
          message: r.message,
          details: rows,
          actionUrl: viewUrl,
        });
      } catch (err) {
        logger.error('[createNotify] email failed for', r.kind, id, err);
      }
    }
  }

  if (r.selection.whatsapp) {
    if (!contact.phone) {
      logger.warn('[createNotify] skipped whatsapp — no phone', r.kind, id);
    } else {
      try {
        const creds = await getDefaultSendCreds();
        if (!creds) {
          logger.warn('[createNotify] skipped whatsapp — no send credentials configured');
        } else {
          const { chatId } = normalizePhone(contact.phone);
          const sig = await getSignature();
          // Create messages carry NO "תזכורת:" prefix — only the fixed signature.
          const base = title && title !== r.message ? `${title}\n${r.message}` : r.message;
          const link = viewUrl ? `\n\nלצפייה במערכת:\n${viewUrl}` : '';
          await sendWhatsAppMessage({
            instanceId: creds.greenInstanceId,
            token: creds.token,
            apiUrl: creds.apiUrl,
            chatId,
            message: `${base}${detailRowsWhatsApp(rows)}${link}${signatureWhatsApp(sig)}`,
          });
        }
      } catch (err) {
        logger.error('[createNotify] whatsapp failed for', r.kind, id, err);
      }
    }
  }
}

export async function dispatchCreateNotifications(
  input: DispatchCreateNotificationsInput,
): Promise<void> {
  try {
    await Promise.allSettled(
      input.recipients.map((r) => sendToRecipient(r, input)),
    );
  } catch (err) {
    logger.error('[createNotify] dispatch failed', err);
  }
}

/** The matrix key for an assignee row — `user:<id>` / `supplier:<id>`. Mirrors
 *  the client `${assignee_type}:${id}` keys and `listEntityAssigneeKeys`. */
export function assigneeRefKey(a: AssigneeRef): string {
  return `${a.assignee_type}:${a.user_id ?? a.supplier_id ?? ''}`;
}

/**
 * The assignees NEWLY added in this update — `current` minus those whose key is
 * in `prevKeys`. The edit-form matrix governs only the added set (a pre-existing
 * assignee already got their notification and must not be re-notified), so the
 * PATCH routes feed this filtered list (not the full assignee list) into
 * `buildMatrixRecipients`.
 */
export function filterAddedAssignees(
  prevKeys: Set<string>,
  current: AssigneeRef[],
): AssigneeRef[] {
  return current.filter((a) => !prevKeys.has(assigneeRefKey(a)));
}

/**
 * Build the matrix recipient list from a recipient-keyed selection + the entity's
 * assignees. Rows: "me" (key 'me') plus one per assignee (key `user:<id>` /
 * `supplier:<id>`). A creator who is also a user assignee is covered by "me"
 * (the assignee row is skipped to avoid a duplicate).
 */
export function buildMatrixRecipients(opts: {
  selection: NotifySelection;
  meUserId: string;
  assignees: AssigneeRef[];
  meMessage: string;
  assigneeMessage: (name: string) => string;
}): CreateNotifyRecipient[] {
  const recipients: CreateNotifyRecipient[] = [];

  const meSel = channelFor(opts.selection, 'me');
  if (meSel.email || meSel.whatsapp) {
    recipients.push({ kind: 'user', userId: opts.meUserId, selection: meSel, message: opts.meMessage });
  }

  for (const a of opts.assignees) {
    if (a.assignee_type === 'user' && a.user_id) {
      if (a.user_id === opts.meUserId) continue; // already covered by "me"
      const sel = channelFor(opts.selection, recipientKey('user', a.user_id));
      if (sel.email || sel.whatsapp) {
        recipients.push({ kind: 'user', userId: a.user_id, selection: sel, message: opts.assigneeMessage(a.display_name ?? '') });
      }
    } else if (a.assignee_type === 'supplier' && a.supplier_id) {
      const sel = channelFor(opts.selection, recipientKey('supplier', a.supplier_id));
      if (sel.email || sel.whatsapp) {
        recipients.push({ kind: 'supplier', supplierId: a.supplier_id, selection: sel, message: opts.assigneeMessage(a.display_name ?? '') });
      }
    }
  }
  return recipients;
}
