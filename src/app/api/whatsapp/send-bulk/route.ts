import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorContact } from '@/lib/db/debtors';
import { listExtraRecipientsForDebtors } from '@/lib/db/contactPeople';
import {
  resolveSendCreds,
  InstanceNotConfiguredError,
  type InstanceCreds,
} from '@/lib/db/whatsappInstances';
import { cleanPhoneField, normalizePhone } from '@/lib/whatsapp';
import { sendAndRecordWhatsApp } from '@/lib/whatsapp-send';
import type { BulkSendProgress, BulkSendSummary } from '@/types/whatsapp';
import { logger } from '@/lib/logger';

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

  let creds: InstanceCreds;
  try {
    creds = await resolveSendCreds(actor, null);
  } catch (err) {
    if (err instanceof InstanceNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // One job per message. Each selected debtor contributes its primary job (the
  // owner-or-tenant phone, as before) plus one job per ADDITIONAL owner/tenant
  // on the apartment card flagged "מקבל הודעות" — so a second owner gets the
  // message too. `total` counts jobs, which is what the progress bar tracks.
  const extras = await listExtraRecipientsForDebtors(ids, ['owner', 'tenant']);
  const extrasByDebtor = new Map<string, string[]>();
  for (const e of extras) {
    const list = extrasByDebtor.get(e.debtor_id);
    if (list) list.push(e.phone);
    else extrasByDebtor.set(e.debtor_id, [e.phone]);
  }
  const jobs: { id: string; phone: string | null }[] = [];
  for (const id of ids) {
    jobs.push({ id, phone: null }); // primary — resolved from the debtor row
    for (const phone of extrasByDebtor.get(id) ?? []) jobs.push({ id, phone });
  }

  const total = jobs.length;
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

      // Debtor rows are reused across a debtor's jobs (primary + extras), and the
      // per-debtor phone set keeps a duplicated number from being messaged twice.
      const debtorCache = new Map<string, Awaited<ReturnType<typeof getDebtorContact>>>();
      const sentPerDebtor = new Map<string, Set<string>>();

      try {
        for (let i = 0; i < jobs.length; i++) {
          if (req.signal.aborted) break;

          const { id, phone: extraPhone } = jobs[i];
          let apartment = '—';
          let status: BulkSendProgress['status'] = 'skipped';
          let reason: string | undefined;

          try {
            if (!debtorCache.has(id)) debtorCache.set(id, await getDebtorContact(id));
            const debtor = debtorCache.get(id) ?? null;
            if (!debtor) {
              summary.skipped++;
              reason = 'החייב לא נמצא';
            } else {
              apartment = debtor.apartment_number;
              const local = extraPhone
                ? cleanPhoneField(extraPhone)
                : cleanPhoneField(debtor.phone_owner) ?? cleanPhoneField(debtor.phone_tenant);
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
                let alreadySent = sentPerDebtor.get(id);
                if (!alreadySent) {
                  alreadySent = new Set<string>();
                  sentPerDebtor.set(id, alreadySent);
                }
                if (intl && alreadySent.has(intl)) {
                  summary.skipped++;
                  reason = 'המספר כבר קיבל את ההודעה';
                } else if (intl) {
                  alreadySent.add(intl);
                  const result = await sendAndRecordWhatsApp({
                    debtor,
                    phoneIntl: intl,
                    rawMessage: message,
                    templateId,
                    actor,
                    creds,
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

          if (i < jobs.length - 1 && !req.signal.aborted) await sleep(DELAY_MS);
        }

        emit(summary);
      } catch (err) {
        logger.error('[whatsapp/send-bulk] stream failed', err);
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
