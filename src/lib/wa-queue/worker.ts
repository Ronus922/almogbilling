import { Pool } from 'pg';
import { createDecipheriv } from 'node:crypto';
import type { Campaign } from './types';
import { makeProvider, type WaProvider } from './provider';
import {
  claimBatch, processRecipient, recoverLeases, reconcile, reconcileStale,
  type SendCreds,
} from './engine';
import { pruneSendLog } from './rate-limit';
import {
  listCampaignAttachments, listAttachmentsNeedingUpload, recordUploadSuccess, recordUploadFailure,
  asciiLeaf, wireFileName, type AttachmentReader, type CampaignAttachment,
} from './attachments';
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
  /** Reads attachment bytes from Storage — needed to upload a campaign's files
   *  to Green API once (uploadFile) and for the per-recipient fallback. Injected
   *  by the entrypoint (scripts/wa-queue-worker.ts); tests pass a stub. */
  readAttachment?: AttachmentReader;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

interface CampaignCtx {
  provider: WaProvider;
  creds: SendCreds;
  ratePerMin: number;
  bucket: string;
  attachments: CampaignAttachment[];
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

  /** One drain tick: heartbeat → recover leases → reconcile stale → prepare
   *  attachments → claim → send. Returns true if it did work (so the loop polls
   *  faster when busy). */
  async tick(): Promise<boolean> {
    await this.heartbeat();
    const rec = await recoverLeases(this.o.pool);
    if (rec.requeued || rec.indeterminate) this.logEvent('lease_recovery', { ...rec });
    await reconcileStale(this.o.pool);
    // Before any lease is held: upload each running campaign's files to Green API
    // once, so every recipient reuses the same link (sendFileByUrl).
    await this.prepareAttachments();

    const items = await claimBatch(this.o.pool, {
      workerId: this.o.workerId, batchSize: this.o.batchSize, leaseSec: this.o.leaseSec,
    });
    if (items.length === 0) return false;

    // group creds/provider/attachments per campaign (cheap cache within the tick)
    const ctxByCampaign = new Map<string, CampaignCtx>();
    for (const item of items) {
      if (this.stopping) {
        // release the unclaimed remainder so shutdown never strands work
        await this.release(item.id);
        continue;
      }
      let ctx = ctxByCampaign.get(item.campaign_id);
      if (!ctx) {
        const campaign = await this.getCampaign(item.campaign_id);
        if (!campaign) { await this.release(item.id); continue; }
        const { provider, creds } = await this.providerFor(campaign);
        const attachments = await listCampaignAttachments(this.o.pool, campaign.id);
        ctx = { provider, creds, ratePerMin: campaign.rate_per_min, bucket: campaign.instance_id ?? 'default', attachments };
        ctxByCampaign.set(item.campaign_id, ctx);
      }
      const res = await processRecipient(this.o.pool, ctx.provider, item, ctx.creds, ctx.bucket, ctx.ratePerMin, {
        backoffBaseSec: this.o.backoffBaseSec,
        attachments: ctx.attachments,
        readAttachment: this.o.readAttachment,
      });
      this.logEvent(`recipient_${res.outcome}`, { recipientId: item.id, campaignId: item.campaign_id, attempt: item.attempt_count });
    }
    for (const [campaignId, ctx] of ctxByCampaign) {
      await reconcile(this.o.pool, campaignId);
      // Keep the rate window table small: rows older than the window are useless.
      await pruneSendLog(this.o.pool, ctx.bucket);
    }
    return true;
  }

  /** uploadFile ONCE per campaign per file (Green API keeps the link 15 days):
   *  every attachment of a running campaign without a usable link is uploaded
   *  here, outside any recipient lease, and the link is persisted for all
   *  workers. After MAX_UPLOAD_ATTEMPTS failures the engine falls back to
   *  sendFileByUpload per recipient. Never throws — a broken file must not stop
   *  the tick for every other campaign. */
  private async prepareAttachments(): Promise<void> {
    let rows: CampaignAttachment[];
    try {
      rows = await listAttachmentsNeedingUpload(this.o.pool);
    } catch (err) {
      this.logEvent('attachment_prepare_error', { error: String(err) });
      return;
    }
    if (rows.length === 0) return;

    const byCampaign = new Map<string, CampaignAttachment[]>();
    for (const a of rows) {
      const id = a.campaign_id ?? '';
      byCampaign.set(id, [...(byCampaign.get(id) ?? []), a]);
    }
    for (const [campaignId, list] of byCampaign) {
      if (this.stopping) return;
      const campaign = await this.getCampaign(campaignId);
      if (!campaign) continue;
      let provider: WaProvider;
      let creds: SendCreds;
      try {
        ({ provider, creds } = await this.providerFor(campaign));
      } catch (err) {
        this.logEvent('attachment_prepare_error', { campaignId, error: String(err) });
        continue;
      }
      for (const a of list) {
        if (this.stopping) return;
        try {
          // The mock never reads bytes (dry-run / tests); the real provider needs them.
          const bytes = provider.kind === 'mock' ? Buffer.alloc(0) : await this.readBytes(a);
          const res = await provider.uploadFile({
            instanceId: creds.instanceId, token: creds.token, apiUrl: creds.apiUrl,
            bytes, mimeType: a.mime_type, fileName: wireFileName(asciiLeaf(a.object_key)),
          });
          if (res.ok) {
            await recordUploadSuccess(this.o.pool, a.id, res.urlFile);
            this.logEvent('attachment_uploaded', { campaignId, attachmentId: a.id, bytes: a.size_bytes });
          } else {
            await recordUploadFailure(this.o.pool, a.id, `${res.message}${res.body ? ` ${res.body}` : ''}`);
            this.logEvent('attachment_upload_failed', { campaignId, attachmentId: a.id, status: res.status, error: res.message });
          }
        } catch (err) {
          await recordUploadFailure(this.o.pool, a.id, String(err));
          this.logEvent('attachment_upload_failed', { campaignId, attachmentId: a.id, error: String(err) });
        }
      }
    }
  }

  private async readBytes(a: CampaignAttachment): Promise<Buffer> {
    if (!this.o.readAttachment) throw new Error('attachment reader not configured');
    return this.o.readAttachment(a);
  }

  private async providerFor(campaign: Campaign): Promise<{ provider: WaProvider; creds: SendCreds }> {
    const provider = this.o.makeProviderFor?.(campaign) ?? makeProvider({ dryRun: campaign.dry_run });
    const creds = campaign.dry_run ? { instanceId: 'dry', token: 'dry' } : await this.credsFor(campaign);
    return { provider, creds };
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
