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
import { sendAndRecordWhatsApp, type SendAndRecordArgs } from '@/lib/whatsapp-send';
import { uploadWhatsAppMedia } from '@/lib/storage/whatsappMedia';
import { validateAttachment } from '@/lib/whatsapp-attachment';

export const runtime = 'nodejs';

interface ParsedInput {
  debtorId: string;
  message: string;
  templateId: string | null;
  requestedPhone: string | null;
  /** Optional single attachment (multipart requests only). */
  file: File | null;
}

// Read the request as either JSON (text-only send — the historical path) or
// multipart/form-data (when the composer attached a file). One shape out.
async function parseInput(req: NextRequest): Promise<ParsedInput | null> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const fileRaw = form.get('file');
    return {
      debtorId: typeof form.get('debtor_id') === 'string' ? (form.get('debtor_id') as string) : '',
      message: typeof form.get('message') === 'string' ? (form.get('message') as string).trim() : '',
      templateId: typeof form.get('template_id') === 'string' && form.get('template_id') ? (form.get('template_id') as string) : null,
      requestedPhone: typeof form.get('phone') === 'string' ? (form.get('phone') as string) : null,
      file: fileRaw instanceof File && fileRaw.size > 0 ? fileRaw : null,
    };
  }
  const body = (await req.json()) as {
    debtor_id?: unknown; message?: unknown; template_id?: unknown; phone?: unknown;
  };
  return {
    debtorId: typeof body.debtor_id === 'string' ? body.debtor_id : '',
    message: typeof body.message === 'string' ? body.message.trim() : '',
    templateId: typeof body.template_id === 'string' ? body.template_id : null,
    requestedPhone: typeof body.phone === 'string' ? body.phone : null,
    file: null,
  };
}

// POST /api/whatsapp/send — send an outbound WhatsApp message to a debtor,
// optionally with a single file attachment (multipart). Gated on whatsapp:edit.
// The response NEVER returns 200 on a send failure — the client toast must
// reflect the true outcome.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let input: ParsedInput | null;
  try {
    input = await parseInput(req);
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!input) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const { debtorId, message, templateId, requestedPhone, file } = input;

  if (!debtorId) {
    return NextResponse.json({ error: 'debtor_id חסר' }, { status: 400 });
  }
  // A message OR a file is required. With a file, the text is an optional caption.
  if (!file && message.length < 1) {
    return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });
  }
  // Text body cap; the caption cap (with a file) is Green API's 1024.
  const maxLen = file ? 1024 : 4096;
  if (message.length > maxLen) {
    return NextResponse.json(
      { error: file ? 'הכיתוב ארוך מדי (מקסימום 1024 תווים)' : 'ההודעה ארוכה מדי (מקסימום 4096 תווים)' },
      { status: 400 },
    );
  }
  // Validate the attachment up-front (type + size) before any upload/send.
  if (file) {
    const err = validateAttachment({ name: file.name, size: file.size });
    if (err) return NextResponse.json({ error: err }, { status: 400 });
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

  // Upload the attachment, then address it through /api/public/wa-media on our own
  // origin (reachable by Green API; the storage host stays hidden). On failure we
  // DON'T send and DON'T record — a clear error only.
  let attachment: SendAndRecordArgs['attachment'] = null;
  if (file) {
    try {
      const uploaded = await uploadWhatsAppMedia(file);
      attachment = {
        url: uploaded.url,
        name: file.name,
        mime: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
      };
    } catch {
      return NextResponse.json({ error: 'העלאת הקובץ נכשלה, ההודעה לא נשלחה' }, { status: 502 });
    }
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
    attachment,
  });

  if (!result.ok) {
    // Real error to the client — 502 (upstream send failed), never 200.
    return NextResponse.json({ error: `שליחה נכשלה: ${result.error}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, idMessage: result.idMessage, ...(result.warning ? { warning: result.warning } : {}) });
}
