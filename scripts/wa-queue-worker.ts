// WhatsApp delivery worker entrypoint.
//   npx tsx scripts/wa-queue-worker.ts
// Runs as its own long-lived process (systemd unit: wa-queue-worker.service,
// template in deploy/wa-queue-worker.service; live in production since 08/2026).
// It runs the SOURCE under tsx, so a code change in src/lib/wa-queue/** takes
// effect only after `sudo systemctl restart wa-queue-worker.service`.
import 'dotenv/config';
import { hostname } from 'node:os';
import { Pool } from 'pg';
import { StorageClient } from '@supabase/storage-js';
import { DeliveryWorker } from '../src/lib/wa-queue/worker';
import type { AttachmentReader } from '../src/lib/wa-queue/attachments';

// Broadcast attachments: the worker needs the object BYTES (to upload them to
// Green API's cloud once per campaign, and for the per-recipient fallback). The
// Next chokepoint (src/lib/storage/server.ts) is 'server-only' and cannot load
// here, so the reader is built in this entrypoint and INJECTED. It downloads
// bytes only — no signed/public URL is ever produced, in line with the
// scripts/guard-no-storage-leak.sh invariant. Missing config → undefined, and
// the engine records a clear per-recipient error instead of crashing.
function makeAttachmentReader(): AttachmentReader | undefined {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return undefined;
  const storage = new StorageClient(`${url.replace(/\/$/, '')}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
  return async (a) => {
    const { data, error } = await storage.from(a.bucket).download(a.object_key);
    if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'empty'}`);
    return Buffer.from(await data.arrayBuffer());
  };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const workerId = `${hostname()}:${process.pid}`;
const worker = new DeliveryWorker({ pool, workerId, readAttachment: makeAttachmentReader() });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ t: new Date().toISOString(), src: 'wa-worker', event: 'signal', signal }));
  worker.requestStop();                 // stop claiming; finish current item
  const deadline = Date.now() + 15_000; // graceful window
  while (Date.now() < deadline) { await new Promise((r) => setTimeout(r, 200)); }
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.runForever().catch((err) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), src: 'wa-worker', event: 'fatal', error: String(err) }));
  process.exit(1);
});
