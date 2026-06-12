// drain-whatsapp-backlog.ts
// Drain any notifications queued on each Green API instance (e.g. that piled up
// while the webhook was misconfigured) by polling receiveNotification, replaying
// each through our LIVE webhook (so the exact production logic stores it), then
// deleteNotification. Idempotent: the webhook dedups on external_message_id.
//
// When a webhook is registered AND reachable, Green API's own worker already
// drains the queue, so this usually finds it empty — that's the expected, healthy
// result. Use it after an outage to flush a residual backlog.
//
// Run (loads the production env):
//   set -a; . /etc/billing/billing.env; set +a; npx tsx scripts/drain-whatsapp-backlog.ts
//   (env file is root-only → run under sudo, see register-whatsapp-webhooks.ts)
//
// Needs: DATABASE_URL, SETTINGS_ENC_KEY, GREEN_API_WEBHOOK_SECRET, APP_URL.

import { Client } from 'pg';
import { createDecipheriv } from 'node:crypto';

interface EncBlob { iv: string; ct: string; tag: string }

function decrypt(blob: EncBlob): string {
  const key = Buffer.from(process.env.SETTINGS_ENC_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_ENC_KEY must decode to 32 bytes');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

function webhookUrl(): string {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  const secret = (process.env.GREEN_API_WEBHOOK_SECRET ?? '').trim();
  if (!app) throw new Error('APP_URL not set');
  if (!secret) throw new Error('GREEN_API_WEBHOOK_SECRET not set');
  return `${app}/api/webhooks/greenapi?secret=${secret}`;
}

const MAX_PER_INSTANCE = 1000; // safety cap against an infinite loop

async function main() {
  const wh = webhookUrl();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = await client.query<{
    display_name: string; green_instance_id: string; green_token_enc: EncBlob; api_url: string;
  }>(`select display_name, green_instance_id, green_token_enc, api_url
        from public.whatsapp_instances order by created_at asc`);

  if (rows.length === 0) {
    console.log('No instances found.');
    await client.end();
    return;
  }

  let grandTotal = 0;
  for (const r of rows) {
    const base = (r.api_url || 'https://api.green-api.com').replace(/\/+$/, '');
    const token = decrypt(r.green_token_enc);
    const idInstance = r.green_instance_id;
    const tag = `${r.display_name} (idInstance=${idInstance})`;

    let processed = 0;
    const byType: Record<string, number> = {};
    let failed = false;

    for (let i = 0; i < MAX_PER_INSTANCE; i++) {
      let recv: { receiptId?: number; body?: unknown } | null = null;
      try {
        const res = await fetch(`${base}/waInstance${idInstance}/receiveNotification/${token}`);
        const text = (await res.text()).trim();
        if (!text || text === 'null') {
          recv = null; // queue empty
        } else {
          try {
            recv = JSON.parse(text) as { receiptId?: number; body?: unknown };
          } catch {
            // Green API returns plain text (e.g. "Message canceled…") rather than
            // JSON when polling isn't the active delivery path — i.e. the webhook
            // is consuming the queue. Treat as empty and report on the first hit.
            if (i === 0) console.log(`  ${tag}: receive queue not active (webhook mode): "${text.slice(0, 80)}"`);
            recv = null;
          }
        }
      } catch (e) {
        console.log(`  ${tag}: receiveNotification FAILED: ${(e as Error).message}`);
        failed = true;
        break;
      }

      if (!recv || typeof recv.receiptId !== 'number') break; // queue empty

      const body = recv.body as { typeWebhook?: string } | undefined;
      const type = body?.typeWebhook ?? 'unknown';

      // Replay through the live webhook (full production processing + dedup).
      try {
        const post = await fetch(wh, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(recv.body ?? {}),
        });
        if (post.status !== 200) {
          console.log(`  ${tag}: webhook replay HTTP ${post.status} for receipt ${recv.receiptId} — stopping (NOT deleted)`);
          failed = true;
          break;
        }
      } catch (e) {
        console.log(`  ${tag}: webhook replay FAILED: ${(e as Error).message} — stopping`);
        failed = true;
        break;
      }

      // Acknowledge — remove from the Green API queue.
      try {
        await fetch(`${base}/waInstance${idInstance}/deleteNotification/${token}/${recv.receiptId}`, {
          method: 'DELETE',
        });
      } catch (e) {
        console.log(`  ${tag}: deleteNotification FAILED for ${recv.receiptId}: ${(e as Error).message} — stopping`);
        failed = true;
        break;
      }

      processed++;
      byType[type] = (byType[type] ?? 0) + 1;
    }

    grandTotal += processed;
    const breakdown = Object.keys(byType).length
      ? ` (${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')})`
      : '';
    console.log(`  ${tag}: drained ${processed}${breakdown}${failed ? ' [stopped early]' : ''}`);
  }

  await client.end();
  console.log(`\nTotal drained: ${grandTotal}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
