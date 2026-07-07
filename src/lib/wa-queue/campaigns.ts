import type { Pool } from 'pg';
import type {
  Campaign, CampaignStatus, RecipientInput,
  CampaignListItem, CampaignDetail, CampaignListPage, CampaignListFilters,
  RecipientLogPage, RecipientLogRow,
} from './types';
import { reconcile } from './engine';

// Campaign lifecycle: durable create/enqueue + the operator controls
// (start / pause / resume / cancel / retry-failed) as an explicit state machine.
// All state lives in the DB — a create returns immediately with a campaign id and
// the worker drains it out of band; nothing depends on an open HTTP request.

export class CampaignConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'CampaignConflictError'; }
}

const COLS = `
  id, type, status, name, body, template_name, audience, instance_id, created_by,
  total_count, pending_count, processing_count, sent_count, failed_count,
  skipped_count, cancelled_count, rate_per_min, dry_run, client_token,
  scheduled_at, started_at, completed_at, paused_at, cancelled_at, last_error,
  created_at, updated_at`;

// Same columns, prefixed for the users join in list/detail reads.
const COLS_W = COLS.split(',').map((c) => `w.${c.trim()}`).join(', ');

export interface CreateCampaignInput {
  name: string;
  body: string;
  /** Chosen template's name (snapshot); null/undefined = free text. */
  templateName?: string | null;
  audience: unknown;
  instanceId: string | null;
  createdBy: string | null;
  recipients: RecipientInput[];
  ratePerMin?: number;
  dryRun?: boolean;
  /** Client-supplied token → a double-submit returns the SAME campaign. */
  clientToken?: string | null;
}

/** Create a campaign and enqueue its recipients atomically. Idempotent on
 *  clientToken: a retry/double-POST returns the existing campaign, never a
 *  duplicate with duplicate sends. Recipients are de-duped by idempotency_key. */
export async function createCampaign(pool: Pool, input: CreateCampaignInput): Promise<Campaign> {
  if (input.clientToken) {
    const existing = await getByClientToken(pool, input.clientToken);
    if (existing) return existing;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query<Campaign>(
      `insert into public.wa_campaigns
         (type, status, name, body, template_name, audience, instance_id, created_by, rate_per_min, dry_run, client_token)
       values ('broadcast','queued',$1,$2,$3,$4::jsonb,$5,$6,coalesce($7,12),coalesce($8,false),$9)
       returning ${COLS}`,
      [input.name, input.body, input.templateName ?? null, JSON.stringify(input.audience ?? {}), input.instanceId,
       input.createdBy, input.ratePerMin ?? null, input.dryRun ?? null, input.clientToken ?? null],
    );
    const campaign = c.rows[0];
    for (const r of input.recipients) {
      await client.query(
        `insert into public.wa_campaign_recipients
           (campaign_id, debtor_id, phone_intl, chat_id, payload, idempotency_key)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (idempotency_key) do nothing`,
        [campaign.id, r.debtorId, r.phoneIntl, `${r.phoneIntl}@c.us`, r.payload, `${campaign.id}:${r.phoneIntl}`],
      );
    }
    await client.query('COMMIT');
    await reconcile(pool, campaign.id); // set total/pending counts from rows
    return (await getCampaign(pool, campaign.id))!;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be broken */ }
    throw err;
  } finally {
    client.release();
  }
}

async function getByClientToken(pool: Pool, token: string): Promise<Campaign | null> {
  const r = await pool.query<Campaign>(`select ${COLS} from public.wa_campaigns where client_token=$1`, [token]);
  return r.rows[0] ?? null;
}

export async function getCampaign(pool: Pool, id: string): Promise<Campaign | null> {
  const r = await pool.query<Campaign>(`select ${COLS} from public.wa_campaigns where id=$1`, [id]);
  return r.rows[0] ?? null;
}

/** Campaign + creator name + delivery-lifecycle counts, for the details header. */
export async function getCampaignDetail(pool: Pool, id: string): Promise<CampaignDetail | null> {
  const r = await pool.query<CampaignDetail>(
    `select ${COLS_W}, u.full_name as created_by_name,
            (select count(*)::int from public.wa_campaign_recipients r
              where r.campaign_id = w.id and r.delivered_at is not null) as delivered_count,
            (select count(*)::int from public.wa_campaign_recipients r
              where r.campaign_id = w.id and r.read_at is not null)      as read_count
       from public.wa_campaigns w
       left join public.users u on u.id = w.created_by
      where w.id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** History list: newest-first, filterable (status / name search / date range),
 *  paginated, with the creator's name joined and a total for the pager. */
export async function listCampaigns(
  pool: Pool, filters: CampaignListFilters = {},
): Promise<CampaignListPage> {
  const where: string[] = ["w.type = 'broadcast'"];
  const params: unknown[] = [];
  if (filters.status) { params.push(filters.status); where.push(`w.status = $${params.length}`); }
  if (filters.q) { params.push(`%${filters.q}%`); where.push(`w.name ilike $${params.length}`); }
  if (filters.from) { params.push(filters.from); where.push(`w.created_at >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); where.push(`w.created_at <= $${params.length}`); }
  const whereSql = where.join(' and ');

  const limit = Math.max(1, Math.min(100, filters.limit ?? 20));
  const offset = Math.max(0, filters.offset ?? 0);

  const total = await pool.query<{ n: number }>(
    `select count(*)::int as n from public.wa_campaigns w where ${whereSql}`, params);
  const rows = await pool.query<CampaignListItem>(
    `select ${COLS_W}, u.full_name as created_by_name
       from public.wa_campaigns w
       left join public.users u on u.id = w.created_by
      where ${whereSql}
      order by w.created_at desc
      limit ${limit} offset ${offset}`,
    params,
  );
  return { rows: rows.rows, total: total.rows[0]?.n ?? 0 };
}

/** Statuses accepted by the recipient-log filter — the six real recipient states
 *  plus two delivery-lifecycle pseudo-states derived from timestamps. */
export type RecipientLogFilter =
  | 'pending' | 'processing' | 'sent' | 'failed' | 'skipped' | 'cancelled'
  | 'delivered' | 'read';

/** Delivery log for one campaign: joins the debtor's name + apartment, masks the
 *  phone IN THE QUERY (the raw number never leaves the DB layer), supports the
 *  status filter (incl. delivered/read pseudo-states) and offset pagination. */
export async function listRecipients(
  pool: Pool, campaignId: string,
  opts: { status?: RecipientLogFilter; limit?: number; offset?: number } = {},
): Promise<RecipientLogPage> {
  const where: string[] = ['r.campaign_id = $1'];
  const params: unknown[] = [campaignId];
  if (opts.status === 'delivered') {
    where.push(`r.delivered_at is not null`);
  } else if (opts.status === 'read') {
    where.push(`r.read_at is not null`);
  } else if (opts.status) {
    params.push(opts.status);
    where.push(`r.status = $${params.length}`);
  }
  const whereSql = where.join(' and ');
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  const total = await pool.query<{ n: number }>(
    `select count(*)::int as n from public.wa_campaign_recipients r where ${whereSql}`, params);
  // Mask: keep the leading 3 (prefix) and trailing 2 digits of the LOCAL number,
  // bullet the rest — '0501234567' → '050-•••-••67'.
  const rows = await pool.query<RecipientLogRow>(
    `select
       r.id, r.status, r.attempt_count, r.sent_at, r.delivered_at, r.read_at,
       r.failed_at, r.last_error, r.error_class, r.created_at,
       coalesce(d.owner_name, d.tenant_name)               as debtor_name,
       d.apartment_number,
       case
         when length(local.n) >= 5
           then substr(local.n,1,3) || '-•••-••' || right(local.n,2)
         else '•••'
       end                                                 as phone_masked
     from public.wa_campaign_recipients r
     left join public.debtors d on d.id = r.debtor_id
     cross join lateral (
       select '0' || right(regexp_replace(r.phone_intl, '\\D', '', 'g'), 9) as n
     ) local
     where ${whereSql}
     order by r.created_at
     limit ${limit} offset ${offset}`,
    params,
  );
  return { rows: rows.rows, total: total.rows[0]?.n ?? 0 };
}

/** Record a delivery-lifecycle event for a campaign recipient (Green API
 *  outgoingMessageStatus webhook), matched by provider_message_id. Advance-only
 *  and idempotent: sets the timestamp only when still null; 'read' implies
 *  'delivered'. Does NOT touch the recipient's status — the row stays 'sent', so
 *  counters never double-count a delivered/read message. Returns rows matched
 *  (0 = the id belongs to a non-campaign message, which is normal). */
export async function markRecipientDelivery(
  pool: Pool, providerMessageId: string, status: 'delivered' | 'read',
): Promise<number> {
  const r = await pool.query(
    `update public.wa_campaign_recipients
        set delivered_at = coalesce(delivered_at, now()),
            read_at = case when $2 = 'read' then coalesce(read_at, now()) else read_at end
      where provider_message_id = $1`,
    [providerMessageId, status],
  );
  return r.rowCount ?? 0;
}

// ── Controls (validated transitions) ──────────────────────────────────────────
async function currentStatus(pool: Pool, id: string): Promise<CampaignStatus> {
  const r = await pool.query<{ status: CampaignStatus }>(`select status from public.wa_campaigns where id=$1`, [id]);
  if (!r.rows[0]) throw new CampaignConflictError('הקמפיין לא נמצא');
  return r.rows[0].status;
}

export async function startCampaign(pool: Pool, id: string): Promise<Campaign> {
  const s = await currentStatus(pool, id);
  if (!['queued', 'paused', 'draft'].includes(s)) throw new CampaignConflictError(`לא ניתן להתחיל קמפיין במצב '${s}'`);
  await pool.query(
    `update public.wa_campaigns set status='running', paused_at=null,
        started_at=coalesce(started_at, now()) where id=$1`, [id]);
  return (await getCampaign(pool, id))!;
}

export async function pauseCampaign(pool: Pool, id: string): Promise<Campaign> {
  const s = await currentStatus(pool, id);
  if (s !== 'running') throw new CampaignConflictError(`ניתן להשהות רק קמפיין 'running' (נוכחי '${s}')`);
  // Stops NEW claims (the claim query only picks 'running' campaigns). In-flight
  // 'processing' items finish or lease-recover — pause never corrupts them.
  await pool.query(`update public.wa_campaigns set status='paused', paused_at=now() where id=$1`, [id]);
  return (await getCampaign(pool, id))!;
}

export async function resumeCampaign(pool: Pool, id: string): Promise<Campaign> {
  const s = await currentStatus(pool, id);
  if (s !== 'paused') throw new CampaignConflictError(`ניתן לחדש רק קמפיין 'paused' (נוכחי '${s}')`);
  await pool.query(`update public.wa_campaigns set status='running', paused_at=null where id=$1`, [id]);
  return (await getCampaign(pool, id))!;
}

/** Stop a campaign. IDEMPOTENT: calling it on an already-terminal campaign (incl.
 *  one already cancelled) is a no-op that returns the current state — repeated
 *  clicks or concurrent requests never re-modify counters. The mutation itself is
 *  a single transaction that flips the campaign to 'cancelled' and marks every
 *  still-eligible recipient ('pending'/'processing') 'cancelled' in one shot, so a
 *  recipient can't slip from pending→sent between the two statements. Already-sent
 *  rows are never touched; an in-flight provider call the worker already started is
 *  allowed to land as 'sent' (its post-send UPDATE has no status guard). */
export async function cancelCampaign(pool: Pool, id: string): Promise<Campaign> {
  const s = await currentStatus(pool, id);
  if (['completed', 'completed_with_errors', 'cancelled', 'failed'].includes(s)) {
    // Idempotent no-op — the campaign is already finished; return it as-is.
    return (await getCampaign(pool, id))!;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`update public.wa_campaigns set status='cancelled', cancelled_at=now() where id=$1`, [id]);
    // Prevent pending items from ever sending; leave already-sent untouched.
    await client.query(
      `update public.wa_campaign_recipients set status='cancelled', lease_expires_at=null
        where campaign_id=$1 and status in ('pending','processing')`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    throw err;
  } finally { client.release(); }
  await reconcile(pool, id);
  return (await getCampaign(pool, id))!;
}

/** Explicit operator action — requeue failed (incl. 'indeterminate') recipients.
 *  The ONLY path that can re-send an indeterminate item: a human decision. Never
 *  touches already-sent recipients, so it cannot duplicate a delivered message. */
export async function retryFailed(pool: Pool, id: string): Promise<{ requeued: number; campaign: Campaign }> {
  const s = await currentStatus(pool, id);
  if (['cancelled', 'draft'].includes(s)) throw new CampaignConflictError(`לא ניתן לנסות שוב קמפיין במצב '${s}'`);
  const r = await pool.query(
    `update public.wa_campaign_recipients
        set status='pending', attempt_count=0, next_attempt_at=now(),
            last_error=null, error_class=null, failed_at=null, send_attempted_at=null
      where campaign_id=$1 and status='failed'`, [id]);
  await pool.query(
    `update public.wa_campaigns set status='running', completed_at=null,
        started_at=coalesce(started_at, now()) where id=$1`, [id]);
  await reconcile(pool, id);
  return { requeued: r.rowCount ?? 0, campaign: (await getCampaign(pool, id))! };
}
