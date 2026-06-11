import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { withTransaction } from '@/lib/db';
import { getDebtorContact } from '@/lib/db/debtors';
import { insertChatMessage, insertChatMessageTx } from '@/lib/db/chatMessages';
import {
  getGreenApiSettings,
  GreenApiNotConfiguredError,
} from '@/lib/db/greenApiSettings';
import { normalizePhone, sendWhatsAppMessage, WhatsAppError } from '@/lib/whatsapp';
import { getPrimaryPhone } from '@/lib/phone';
import { logDebtorEvent, EVENT_TYPE_META } from '@/lib/debtor-events';

export const runtime = 'nodejs';

interface PostBody {
  debtor_id?: unknown;
  message?: unknown;
  template_id?: unknown;
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

  const rawPhone = getPrimaryPhone(debtor);
  if (!rawPhone) {
    return NextResponse.json({ error: 'לחייב אין מספר טלפון תקין' }, { status: 400 });
  }

  // Normalise phone — bad numbers are a 400, not a server error.
  let phone: string;
  let chatId: string;
  try {
    ({ phone, chatId } = normalizePhone(rawPhone));
  } catch (err) {
    if (err instanceof WhatsAppError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
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

  // Attempt the send.
  let idMessage: string;
  try {
    ({ idMessage } = await sendWhatsAppMessage({ instanceId, token, chatId, message }));
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    // Record the failed attempt (no external id, no last_whatsapp_sent_at,
    // no timeline event) so the failure is visible in the debtor's history.
    try {
      await insertChatMessage({
        debtorId,
        contactPhone: phone,
        chatId,
        externalMessageId: null,
        direction: 'sent',
        content: message,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
      });
    } catch (logErr) {
      console.error('[whatsapp/send] failed to record failed message', logErr);
    }
    // Real error to the client — 502 (upstream send failed), never 200.
    return NextResponse.json({ error: `שליחה נכשלה: ${detail}` }, { status: 502 });
  }

  // Success: persist the message, bump last_whatsapp_sent_at, and log a WHATSAPP
  // event on the unified timeline — all atomically.
  const actorName = actor.full_name || actor.username;
  try {
    await withTransaction(async (client) => {
      await insertChatMessageTx(client, {
        debtorId,
        contactPhone: phone,
        chatId,
        externalMessageId: idMessage,
        direction: 'sent',
        content: message,
        status: 'sent',
        errorDetail: null,
        sentBy: actor.id,
      });

      await client.query(
        `update public.debtors set last_whatsapp_sent_at = now() where id = $1`,
        [debtorId],
      );

      await logDebtorEvent(client, {
        debtorId,
        eventType: 'WHATSAPP',
        title: EVENT_TYPE_META.WHATSAPP.label,
        description: message,
        metadata: {
          external_message_id: idMessage,
          chat_id: chatId,
          template_id: templateId,
          channel: 'green_api',
        },
        actor: { id: actor.id, name: actorName, email: actor.email },
      });
    });
  } catch (err) {
    // The message WAS delivered to WhatsApp; only our bookkeeping failed. Report
    // it honestly rather than claiming a clean success.
    console.error('[whatsapp/send] post-send persistence failed', err);
    return NextResponse.json(
      { ok: true, idMessage, warning: 'ההודעה נשלחה אך תיעוד ההיסטוריה נכשל' },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true, idMessage });
}
