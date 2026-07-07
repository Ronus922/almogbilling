import type { Pool } from 'pg';

// Queue health for monitoring / self-heal. All DB-derived, cheap, secret-free.

export interface QueueHealth {
  workerAlive: boolean;
  lastBeatAgeSec: number | null;
  pending: number;
  processing: number;
  oldestPendingAgeSec: number | null;
  expiredLeases: number;
  runningCampaigns: number;
  /** running/queued campaigns with no pending+processing work — should have rolled
   *  up to a terminal state; a non-zero count means reconciliation is overdue. */
  stuckCampaigns: number;
  ok: boolean;
}

export async function queueHealth(pool: Pool, opts: { workerStaleSec?: number } = {}): Promise<QueueHealth> {
  const staleSec = opts.workerStaleSec ?? 120;
  const r = await pool.query<{
    last_beat_age: number | null; pending: number; processing: number;
    oldest_pending_age: number | null; expired_leases: number;
    running_campaigns: number; stuck_campaigns: number;
  }>(
    `select
       extract(epoch from (now() - max(h.last_beat_at)))::int as last_beat_age,
       (select count(*)::int from public.wa_campaign_recipients where status='pending')      as pending,
       (select count(*)::int from public.wa_campaign_recipients where status='processing')   as processing,
       (select extract(epoch from (now() - min(next_attempt_at)))::int
          from public.wa_campaign_recipients where status='pending')                          as oldest_pending_age,
       (select count(*)::int from public.wa_campaign_recipients
         where status='processing' and lease_expires_at < now())                              as expired_leases,
       (select count(*)::int from public.wa_campaigns where status in ('running','queued'))   as running_campaigns,
       (select count(*)::int from public.wa_campaigns c where c.status in ('running','queued')
          and not exists (select 1 from public.wa_campaign_recipients r
                           where r.campaign_id=c.id and r.status in ('pending','processing'))) as stuck_campaigns
     from public.wa_worker_heartbeat h`,
  );
  const row = r.rows[0];
  const lastBeatAgeSec = row?.last_beat_age ?? null;
  const workerAlive = lastBeatAgeSec !== null && lastBeatAgeSec <= staleSec;
  const health: QueueHealth = {
    workerAlive,
    lastBeatAgeSec,
    pending: row?.pending ?? 0,
    processing: row?.processing ?? 0,
    oldestPendingAgeSec: row?.oldest_pending_age ?? null,
    expiredLeases: row?.expired_leases ?? 0,
    runningCampaigns: row?.running_campaigns ?? 0,
    stuckCampaigns: row?.stuck_campaigns ?? 0,
    ok: false,
  };
  // Healthy = worker beating (or nothing to do) and nothing stuck/lagging badly.
  health.ok =
    (health.workerAlive || (health.pending === 0 && health.processing === 0)) &&
    health.stuckCampaigns === 0 &&
    (health.oldestPendingAgeSec === null || health.oldestPendingAgeSec < 900);
  return health;
}
