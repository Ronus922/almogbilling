import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorContact } from '@/lib/db/debtors';
import {
  getGreenApiSettings,
  GreenApiNotConfiguredError,
} from '@/lib/db/greenApiSettings';
import { normalizePhone, parsePhoneCandidates, WhatsAppError } from '@/lib/whatsapp';
import { sendAndRecordWhatsApp } from '@/lib/whatsapp-send';

export const runtime = 'nodejs';

interface PostBody {
  debtor_id?: unknown;
  message?: unknown;
  template_id?: unknown;
  phone?: unknown;
}

// POST /api/whatsapp/send — send an outbound WhatsApp message to a debtor.
// Sending is gated on whatsapp:edit (write). The response NEVER returns 200 on a
// send failure — the client toast must reflect the true outcome.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const debtorId = typeof body.debtor_id === 'string' ? body.debtor_id : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const templateId = typeof body.template_id === 'string' ? body.template_id : null;
  const requestedPhone = typeof body.phone === 'string' ? body.phone : null;

  if (!debtorId) {
    return NextResponse.json({ error: 'debtor_id חסר' }, { status: 400 });
  }
  if (message.length < 1) {
    return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });
  }
  if (message.length > 4096) {
    return NextResponse.json({ error: 'ההודעה ארוכה מדי (מקסימום 4096 תווים)' }, { status: 400 });
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

  // Resolve credentials. Missing config is a real error (not a send attempt).
  let instanceId: string;
  let token: string;
  try {
    ({ instanceId, token } = await getGreenApiSettings());
  } catch (err) {
    if (err instanceof GreenApiNotConfiguredError) {
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
    instanceId,
    token,
  });

  if (!result.ok) {
    // Real error to the client — 502 (upstream send failed), never 200.
    return NextResponse.json({ error: `שליחה נכשלה: ${result.error}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, idMessage: result.idMessage, ...(result.warning ? { warning: result.warning } : {}) });
}
