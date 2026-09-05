import { Pool } from 'pg';
import { createDecipheriv } from 'node:crypto';
import type { Campaign } from './types';
import { makeProvider, type WaProvider } from './provider';
import {
  claimBatch, processRecipient, recoverLeases, reconcile, reconcileStale,
  type SendCreds,
} from './engine';
import { logger } from '@/lib/logger';
import { env } from '@/env';

// Standalone WhatsApp delivery worker. Runs as its OWN process (systemd on the
// billing box — NOT inside the Next server, NOT tied to any HTTP request), owns
// its own pg Pool, drains the queue, and shuts down gracefully. Multiple workers
// are safe (claim uses FOR UPDATE SKIP LOCKED; the rate limit is DB-shared).

export interface WorkerOptions {
  pool: Pool;
  workerId: string;
  batchSize?: number;
  leaseSec?: number;
  idlePollMs?: number;
  /** retry backoff base (seconds); default 5. Tests use a small value. */
  backoffBaseSec?: number;
  /** provide creds for the real provider; omitted for dry-run-only runs/tests. */
  resolveCreds?: (campaign: Campaign) => Promise<SendCreds>;
  /** injected provider (tests). Default: dry_run→mock, else real Green API. */
  makeProviderFor?: (campaign: Campaign) => WaProvider;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export class DeliveryWorker {
  private stopping = false;
  private running = false;
  private readonly o: Required<Pick<WorkerOptions, 'batchSize' | 'leaseSec' | 'idlePollMs'>> & WorkerOptions;

  constructor(opts: WorkerOptions) {
    this.o = { batchSize: 10, leaseSec: 60, idlePollMs: 1000, ...opts };
  }

  private logEvent(event: string, data?: Record<string, unknown>) {
    (this.o.log ?? defaultLog)(event, data);
  }

  /** Ask the worker to stop after the current item (graceful). */
  requestStop() { this.stopping = true; }

  async runForever(): Promise<void> {
    this.running = true;
    this.logEvent('worker_startup', { workerId: this.o.workerId });
    while (!this.stopping) {
      const did = await this.tick();
      if (!did) await sleep(this.o.idlePollMs);
    }
    this.running = false;
    this.logEvent('worker_shutdown', { workerId: this.o.workerId });
  }

  /** One drain tick: heartbeat → recover leases → reconcile stale → claim → send.
   *  Returns true if it did work (so the loop polls faster when busy). */
  async tick(): Promise<boolean> {
    await this.heartbeat();
    const rec = await recoverLeases(this.o.pool);
    if (rec.requeued || rec.indeterminate) this.logEvent('lease_recovery', { ...rec });
    await reconcileStale(this.o.pool);

    const items = await claimBatch(this.o.pool, {
      workerId: this.o.workerId, batchSize: this.o.batchSize, leaseSec: this.o.leaseSec,
    });
    if (items.length === 0) return false;

    // group creds/provider per campaign (cheap cache within the tick)
    const provByCampaign = new Map<string, { provider: WaProvider; creds: SendCreds; ratePerMin: number; bucket: string }>();
    for (const item of items) {
      if (this.stopping) {
        // release the unclaimed remainder so shutdown never strands work
        await this.release(item.id);
        continue;
      }
      let ctx = provByCampaign.get(item.campaign_id);
      if (!ctx) {
        const campaign = await this.getCampaign(item.campaign_id);
        if (!campaign) { await this.release(item.id); continue; }
        const provider = this.o.makeProviderFor?.(campaign) ?? makeProvider({ dryRun: campaign.dry_run });
        const creds = campaign.dry_run ? { instanceId: 'dry', token: 'dry' } : await this.credsFor(campaign);
        ctx = { provider, creds, ratePerMin: campaign.rate_per_min, bucket: campaign.instance_id ?? 'default' };
        provByCampaign.set(item.campaign_id, ctx);
      }
      const res = await processRecipient(this.o.pool, ctx.provider, item, ctx.creds, ctx.bucket, ctx.ratePerMin, { backoffBaseSec: this.o.backoffBaseSec });
      this.logEvent(`recipient_${res.outcome}`, { recipientId: item.id, campaignId: item.campaign_id, attempt: item.attempt_count });
    }
    for (const campaignId of provByCampaign.keys()) await reconcile(this.o.pool, campaignId);
    return true;
  }

  private async getCampaign(id: string): Promise<Campaign | null> {
    const r = await this.o.pool.query<Campaign>(`select * from public.wa_campaigns where id=$1`, [id]);
    return r.rows[0] ?? null;
  }

  private async release(recipientId: string) {
    await this.o.pool.query(
      `update public.wa_campaign_recipients
          set status='pending', worker_id=null, lease_expires_at=null,
              processing_started_at=null, attempt_count=greatest(0, attempt_count-1)
        where id=$1 and status='processing'`, [recipientId]);
  }

  private async credsFor(campaign: Campaign): Promise<SendCreds> {
    if (this.o.resolveCreds) return this.o.resolveCreds(campaign);
    return resolveInstanceCreds(this.o.pool, campaign.instance_id);
  }

  private async heartbeat() {
    await this.o.pool.query(
      `insert into public.wa_worker_heartbeat (worker_id, last_beat_at) values ($1, now())
         on conflict (worker_id) do update set last_beat_at = now()`,
      [this.o.workerId],
    );
  }
}

function defaultLog(event: string, data?: Record<string, unknown>) {
  // structured, secret-free (never logs tokens or full message bodies);
  // pino adds the timestamp — the fields land on the record, the event is the msg.
  logger.info({ src: 'wa-worker', event, ...data }, event);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Real-provider creds: read the encrypted token from whatsapp_instances and
// decrypt with SETTINGS_ENC_KEY (mirrors src/lib/crypto/settings-cipher.ts so the
// worker needs no Next 'server-only' import). Only used for non-dry-run sends.
async function resolveInstanceCreds(pool: Pool, instanceId: string | null): Promise<SendCreds> {
  const r = await pool.query<{ green_instance_id: string; green_token_enc: { iv: string; ct: string; tag: string }; api_url: string }>(
    `select green_instance_id, green_token_enc, api_url from public.whatsapp_instances
      where ($1::uuid is null and true) or id=$1 order by (state='authorized') desc, created_at asc limit 1`,
    [instanceId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('no whatsapp instance configured for send');
  return { instanceId: row.green_instance_id, token: decryptToken(row.green_token_enc), apiUrl: row.api_url };
}

function decryptToken(blob: { iv: string; ct: string; tag: string }): string {
  const key = Buffer.from(env.SETTINGS_ENC_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_ENC_KEY missing/invalid (fail-closed)');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}
