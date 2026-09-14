import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorContact } from '@/lib/db/debtors';
import {
  resolveSendCreds,
  InstanceNotConfiguredError,
  type InstanceCreds,
} from '@/lib/db/whatsappInstances';
import { normalizePhone, parsePhoneCandidates, WhatsAppError } from '@/lib/whatsapp';
import { sendAndRecordWhatsApp } from '@/lib/whatsapp-send';
import { listStagedMessageAttachments, type MessageAttachment } from '@/lib/db/whatsappMessageAttachments';
import { messageAttachmentIdsSchema } from '@/lib/validation/requests';
import { validateBroadcastAttachmentSet, WHATSAPP_MESSAGE_MAX_FILES } from '@/lib/constants/whatsappAttachments';

export const runtime = 'nodejs';

interface ParsedInput {
  debtorId: string;
  message: string;
  templateId: string | null;
  requestedPhone: string | null;
  /** Ids of files already staged through /api/whatsapp/messages/attachments,
   *  in the order the composer listed them (= the send order). */
  attachmentIds: string[];
}

// JSON in, one shape out. Files are NOT posted here any more: the composer
// uploads each one to /api/whatsapp/messages/attachments as it is picked and
// sends only the resulting ids, so this request stays small and the bytes live
// in the private bucket from the start.
async function parseInput(req: NextRequest): Promise<ParsedInput | { error: string } | null> {
  const body = (await req.json()) as {
    debtor_id?: unknown; message?: unknown; template_id?: unknown; phone?: unknown; attachment_ids?: unknown;
  };
  const ids = messageAttachmentIdsSchema.safeParse(body.attachment_ids);
  if (!ids.success) return { error: ids.error.issues[0]?.message ?? 'קבצים מצורפים לא תקינים' };
  return {
    debtorId: typeof body.debtor_id === 'string' ? body.debtor_id : '',
    message: typeof body.message === 'string' ? body.message.trim() : '',
    templateId: typeof body.template_id === 'string' ? body.template_id : null,
    requestedPhone: typeof body.phone === 'string' ? body.phone : null,
    attachmentIds: Array.from(new Set(ids.data)),
  };
}

// POST /api/whatsapp/send — send an outbound WhatsApp message to a debtor, with
// up to WHATSAPP_MESSAGE_MAX_FILES attachments staged beforehand. Gated on
// whatsapp:edit. The response NEVER returns 200 on a send failure — the client
// toast must reflect the true outcome — and answers 207 when the message went
// out but some files did not.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let input: ParsedInput | { error: string } | null;
  try {
    input = await parseInput(req);
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!input) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });

  const { debtorId, message, templateId, requestedPhone, attachmentIds } = input;
  const hasFiles = attachmentIds.length > 0;

  if (!debtorId) {
    return NextResponse.json({ error: 'debtor_id חסר' }, { status: 400 });
  }
  // A message OR a file is required. With files, the text is an optional caption.
  if (!hasFiles && message.length < 1) {
    return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });
  }
  // One body cap for every case. A single file normally carries the text as its
  // caption (Green API caps that at 1024), but planMessageSends sends a longer
  // text as its own message first instead of refusing it.
  if (message.length > 4096) {
    return NextResponse.json({ error: 'ההודעה ארוכה מדי (מקסימום 4096 תווים)' }, { status: 400 });
  }

  // The staged files must be THIS actor's and still unsent; the per-message cap
  // and the total size are enforced here — the server is the authority.
  let attachments: MessageAttachment[] = [];
  if (hasFiles) {
    attachments = await listStagedMessageAttachments(attachmentIds, actor.id);
    if (attachments.length !== attachmentIds.length) {
      return NextResponse.json({ error: 'קובץ מצורף לא נמצא — הסר אותו וצרף מחדש' }, { status: 400 });
    }
    const setError = validateBroadcastAttachmentSet(
      attachments.map((a) => ({ size: a.size_bytes })), [], WHATSAPP_MESSAGE_MAX_FILES,
    );
    if (setError) return NextResponse.json({ error: setError }, { status: 400 });
  }

  const debtor = await getDebtorContact(debtorId);
  if (!debtor) {
    return NextResponse.json({ error: 'החייב לא נמצא' }, { status: 404 });
  }

  // Parse the debtor's (possibly compound) phone field(s) into valid candidates.
  const candidates = parsePhoneCandidates(
    `${debtor.phone_owner ?? ''} ${debtor.phone_tenant ?? ''}`,
  );
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'לחייב אין מספר טלפון תקין' }, { status: 400 });
  }

  // Re-validate the client's selected number server-side: it must normalise AND
  // belong to the debtor's candidate set. Absent → default to the first.
  let phone: string;
  if (requestedPhone) {
    let normalized: string;
    try {
      ({ phone: normalized } = normalizePhone(requestedPhone));
    } catch (err) {
      if (err instanceof WhatsAppError) {
        return NextResponse.json({ error: `מספר הטלפון שנבחר אינו תקין: ${err.message}` }, { status: 400 });
      }
      throw err;
    }
    if (!candidates.some((c) => c.phone === normalized)) {
      return NextResponse.json({ error: 'המספר שנבחר אינו שייך לחייב זה' }, { status: 400 });
    }
    phone = normalized;
  } else {
    phone = candidates[0].phone;
  }

  // Resolve the shared instance. Missing config is a real error (not a send).
  let creds: InstanceCreds;
  try {
    creds = await resolveSendCreds(actor, null);
  } catch (err) {
    if (err instanceof InstanceNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // Send + record (failed-row on the timeline, last_whatsapp_sent_at bump, WHATSAPP
  // event) — shared with the bulk path so the two can never diverge.
  const result = await sendAndRecordWhatsApp({
    debtor,
    phoneIntl: phone,
    rawMessage: message,
    templateId,
    actor,
    creds,
    attachments,
  });

  if (!result.ok) {
    // Real error to the client — 502 (upstream send failed), never 200.
    return NextResponse.json(
      {
        error: `שליחה נכשלה: ${result.error}`,
        ...(result.failedAttachments ? { failed_attachments: result.failedAttachments } : {}),
      },
      { status: 502 },
    );
  }
  // The message went out but one or more files did not: 207, with their names,
  // so the composer can say exactly what the recipient did not get.
  const partial = result.failedAttachments?.length ? result.failedAttachments : null;
  return NextResponse.json(
    {
      ok: true,
      idMessage: result.idMessage,
      ...(result.warning ? { warning: result.warning } : {}),
      ...(partial ? { failed_attachments: partial } : {}),
    },
    partial ? { status: 207 } : undefined,
  );
}
