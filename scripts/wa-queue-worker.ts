// WhatsApp delivery worker entrypoint.
//   npx tsx scripts/wa-queue-worker.ts
// Runs as its own long-lived process (systemd unit: deploy/wa-queue-worker.service).
// NOT wired to production yet — start only after the Phase 2 cutover is approved.
import 'dotenv/config';
import { hostname } from 'node:os';
import { Pool } from 'pg';
import { DeliveryWorker } from '../src/lib/wa-queue/worker';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const workerId = `${hostname()}:${process.pid}`;
const worker = new DeliveryWorker({ pool, workerId });

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
