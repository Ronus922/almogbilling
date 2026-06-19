import 'server-only';
import { appUrl } from '@/lib/config';
import { getNotificationRecipient } from '@/lib/db/users';
import { getSupplierNotifyContact } from '@/lib/db/suppliers';
import { sendNotificationEmail } from '@/services/email';
import { sendWhatsAppMessage, normalizePhone } from '@/lib/whatsapp';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import {
  channelFor,
  recipientKey,
  type NotifyChannelSelection,
  type NotifySelection,
} from '@/lib/notify/selection';
import type { AssigneeRef } from '@/lib/types/assignee';

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

export interface DispatchCreateNotificationsInput {
  /** Email subject / WhatsApp heading. */
  title: string;
  /** Relative deep-link, e.g. `/tasks?task=<id>`. */
  actionUrl: string;
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
  title: string,
  actionUrl: string,
): Promise<void> {
  if (!r.selection.email && !r.selection.whatsapp) return;
  const id = r.kind === 'user' ? r.userId : r.supplierId;
  const contact = await resolveContact(r);
  if (!contact) return;

  if (r.selection.email) {
    if (!contact.email) {
      console.warn('[createNotify] skipped email — no address', r.kind, id);
    } else {
      try {
        await sendNotificationEmail(contact.email, {
          recipientName: contact.name,
          title,
          message: r.message,
          actionUrl: `${appUrl()}${actionUrl}`,
        });
      } catch (err) {
        console.error('[createNotify] email failed for', r.kind, id, err);
      }
    }
  }

  if (r.selection.whatsapp) {
    if (!contact.phone) {
      console.warn('[createNotify] skipped whatsapp — no phone', r.kind, id);
    } else {
      try {
        const creds = await getDefaultSendCreds();
        if (!creds) {
          console.warn('[createNotify] skipped whatsapp — no send credentials configured');
        } else {
          const { chatId } = normalizePhone(contact.phone);
          const body = title && title !== r.message ? `${title}\n${r.message}` : r.message;
          await sendWhatsAppMessage({
            instanceId: creds.greenInstanceId,
            token: creds.token,
            apiUrl: creds.apiUrl,
            chatId,
            message: body,
          });
        }
      } catch (err) {
        console.error('[createNotify] whatsapp failed for', r.kind, id, err);
      }
    }
  }
}

export async function dispatchCreateNotifications(
  input: DispatchCreateNotificationsInput,
): Promise<void> {
  try {
    await Promise.allSettled(
      input.recipients.map((r) => sendToRecipient(r, input.title, input.actionUrl)),
    );
  } catch (err) {
    console.error('[createNotify] dispatch failed', err);
  }
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
