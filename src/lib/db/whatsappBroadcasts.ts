import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { Broadcast, BroadcastAudience, BroadcastStatus } from '@/types/whatsapp';

// CRUD + progress bookkeeping for WhatsApp broadcasts (bulk campaigns).
// The background runner (src/lib/whatsapp-broadcast.ts) bumps the counters as it
// sends; the UI polls listRecentBroadcasts for progress bars.

const SELECT_COLUMNS = `
  id, name, body, audience_filter, total_count, sent_count, failed_count,
  status, created_by, created_at, completed_at
`;

export async function createBroadcast(input: {
  name: string;
  body: string;
  audience: BroadcastAudience;
  totalCount: number;
  createdBy: string;
  /** Sending Green API instance (uuid). */
  instanceId?: string | null;
}): Promise<Broadcast> {
  const row = await queryOne<Broadcast>(
    `insert into public.whatsapp_broadcasts
       (name, body, audience_filter, total_count, status, created_by, instance_id)
     values ($1, $2, $3::jsonb, $4, 'running', $5, $6)
     returning ${SELECT_COLUMNS}`,
    [input.name, input.body, JSON.stringify(input.audience), input.totalCount, input.createdBy, input.instanceId ?? null],
  );
  return row as Broadcast;
}

export async function getBroadcast(id: string): Promise<Broadcast | null> {
  return queryOne<Broadcast>(
    `select ${SELECT_COLUMNS} from public.whatsapp_broadcasts where id = $1`,
    [id],
  );
}

export async function listRecentBroadcasts(limit = 20): Promise<Broadcast[]> {
  const r = await query<Broadcast>(
    `select ${SELECT_COLUMNS}
       from public.whatsapp_broadcasts
      order by created_at desc
      limit $1`,
    [Math.max(1, Math.min(100, limit))],
  );
  return r.rows;
}

/** Atomically increment the sent/failed counters as the runner progresses. */
export async function bumpBroadcastCounters(
  id: string,
  delta: { sent?: number; failed?: number },
): Promise<void> {
  await query(
    `update public.whatsapp_broadcasts
        set sent_count   = sent_count   + $2,
            failed_count = failed_count + $3
      where id = $1`,
    [id, delta.sent ?? 0, delta.failed ?? 0],
  );
}

/** Final status + completed_at when the runner finishes (or crashes). */
export async function finishBroadcast(id: string, status: BroadcastStatus): Promise<void> {
  await query(
    `update public.whatsapp_broadcasts
        set status = $2, completed_at = now()
      where id = $1`,
    [id, status],
  );
}
