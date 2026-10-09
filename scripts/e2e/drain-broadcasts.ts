// E2E only — drains the named broadcasts with the REAL DeliveryWorker:
//   node node_modules/tsx/dist/cli.mjs scripts/e2e/drain-broadcasts.ts '<json names>' <base64 file bytes>
//
// The e2e stack runs no wa-queue-worker and has no reachable Storage, so
// e2e/broadcast-email.spec.ts calls this under tsx — the same runtime as the
// production worker — with two stand-ins only: the attachment reader returns
// the fixture bytes, and WhatsApp goes through MockProvider (nothing reaches
// Green API). The email path is the real one: SMTP settings from app_settings,
// the transport from SMTP_HOST/SMTP_PORT, which the spec points at Mailpit —
// and this script refuses to run against anything but a local mail server.
// Prints {"whatsapp":[chatIds…]} on success.
import { Pool } from 'pg';
import { DeliveryWorker } from '../../src/lib/wa-queue/worker';
import { MockProvider } from '../../src/lib/wa-queue/provider';
import { smtpTransportBase } from '../../src/lib/email/smtp-core';

const names = JSON.parse(process.argv[2] ?? '[]') as string[];
const fixture = Buffer.from(process.argv[3] ?? '', 'base64');

async function main(): Promise<void> {
  const host = smtpTransportBase().host;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`refusing to send: SMTP host is ${host}, not local`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  pool.on('error', () => undefined);
  const provider = new MockProvider();
  const worker = new DeliveryWorker({
    pool, workerId: `e2e-drain-${process.pid}`, idlePollMs: 5, backoffBaseSec: 0,
    makeProviderFor: () => provider,
    readAttachment: async () => fixture,
    log: () => undefined,
  });
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      await worker.tick();
      const r = await pool.query<{ n: number }>(
        `select count(*)::int n from public.wa_campaigns
          where name = any($1::text[]) and status not in ('completed','completed_with_errors','cancelled','failed')`,
        [names]);
      if (r.rows[0].n === 0) break;
      if (Date.now() > deadline) throw new Error('broadcasts did not finish within 30s');
      await new Promise((res) => setTimeout(res, 50));
    }
    process.stdout.write(`${JSON.stringify({ whatsapp: provider.sends.map((s) => s.chatId) })}\n`);
  } finally {
    await pool.end();
  }
}

// Exit explicitly: the pooled SMTP connection would otherwise hold the process
// open until its idle timeout.
main().then(() => process.exit(0), (err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
