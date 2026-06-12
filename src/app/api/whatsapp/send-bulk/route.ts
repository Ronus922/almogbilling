import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorContact } from '@/lib/db/debtors';
import { getGreenApiSettings, GreenApiNotConfiguredError } from '@/lib/db/greenApiSettings';
import { cleanPhoneField, normalizePhone } from '@/lib/whatsapp';
import { sendAndRecordWhatsApp } from '@/lib/whatsapp-send';
import type { BulkSendProgress, BulkSendSummary } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RECIPIENTS = 50;
const DELAY_MS = 2500; // anti-ban pacing between Green API sends

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// POST /api/whatsapp/send-bulk — send one message to many debtors, serially with
// a delay between sends. Streams NDJSON progress (one line per recipient) plus a
// final summary, so the client shows live "X מתוך Y" and the connection stays
// active through nginx (X-Accel-Buffering: no). Gated on whatsapp:edit.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: { debtor_ids?: unknown; message?: unknown; template_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const ids = Array.isArray(body.debtor_ids)
    ? [...new Set(body.debtor_ids.filter((x): x is string => typeof x === 'string'))]
    : [];
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const templateId = typeof body.template_id === 'string' ? body.template_id : null;

  if (ids.length === 0) {
    return NextResponse.json({ error: 'לא נבחרו נמענים' }, { status: 400 });
  }
  if (ids.length > MAX_RECIPIENTS) {
    return NextResponse.json({ error: `ניתן לשלוח עד ${MAX_RECIPIENTS} נמענים בבת אחת` }, { status: 400 });
  }
  if (message.length < 1) {
    return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });
  }
  if (message.length > 4096) {
    return NextResponse.json({ error: 'ההודעה ארוכה מדי (מקסימום 4096 תווים)' }, { status: 400 });
  }

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

  const total = ids.length;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (obj: BulkSendProgress | BulkSendSummary) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          closed = true;
        }
      };

      const summary: BulkSendSummary = { type: 'summary', sent: 0, failed: 0, skipped: 0, failures: [] };

      try {
        for (let i = 0; i < ids.length; i++) {
          if (req.signal.aborted) break;

          const id = ids[i];
          let apartment = '—';
          let status: BulkSendProgress['status'] = 'skipped';
          let reason: string | undefined;

          try {
            const debtor = await getDebtorContact(id);
            if (!debtor) {
              summary.skipped++;
              reason = 'החייב לא נמצא';
            } else {
              apartment = debtor.apartment_number;
              const local = cleanPhoneField(debtor.phone_owner) ?? cleanPhoneField(debtor.phone_tenant);
              if (!local) {
                summary.skipped++;
                reason = 'אין מספר טלפון תקין';
              } else {
                let intl = '';
                try {
                  intl = normalizePhone(local).phone;
                } catch {
                  summary.skipped++;
                  reason = 'מספר טלפון לא תקין';
                }
                if (intl) {
                  const result = await sendAndRecordWhatsApp({
                    debtor,
                    phoneIntl: intl,
                    rawMessage: message,
                    templateId,
                    actor,
                    instanceId,
                    token,
                  });
                  if (result.ok) {
                    summary.sent++;
                    status = 'sent';
                  } else {
                    summary.failed++;
                    status = 'failed';
                    reason = result.error;
                    summary.failures.push({ apartment, error: result.error ?? 'שגיאה' });
                  }
                }
              }
            }
          } catch (err) {
            summary.failed++;
            status = 'failed';
            reason = (err as Error).message;
            summary.failures.push({ apartment, error: (err as Error).message });
          }

          emit({ type: 'progress', index: i + 1, total, apartment, status, ...(reason ? { reason } : {}) });

          if (i < ids.length - 1 && !req.signal.aborted) await sleep(DELAY_MS);
        }

        emit(summary);
      } catch (err) {
        console.error('[whatsapp/send-bulk] stream failed', err);
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
