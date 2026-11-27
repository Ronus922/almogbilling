import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { enqueueDocumentInTx } from '@/lib/db/chipOrderDocuments';
import { israelDate } from '@/lib/morning/documents';
import { chipOrderDueAt, type ChipOrderStatus } from '@/lib/chipOrders/model';
import type { CardEnv, CardStatus } from '@/lib/chipOrders/card';

// Chip orders — the card payment on the order (migration 20261125130957).
// The ONE place an order becomes paid by card is recordCardPayment below, and
// it is only ever called with what the processor itself reported: a callback
// whose signature was checked, or the reply of a server-side lookup.
//
// Every payment session this server opens is a row of chip_order_card_sessions.
// A charge — approved or refused — touches an order only when it names one of
// THAT order's sessions; the order number alone never does.

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

/** How long the invoice of a reception card payment waits for the window's
 *  "שמור" (which completes the orderer and releases it) before it is issued
 *  with what the order has. */
export const RECEPTION_INVOICE_HOLD_MINUTES = 30;

/** A session is asked about for this long after it was opened: the page
 *  request lives 30 minutes (PAGE_EXPIRY_MINUTES), plus a margin for a charge
 *  that was submitted at the last moment. For as long, the order's payment
 *  page may still be charged — the purge leaves such an order alone. */
export const SESSION_LOOKUP_MINUTES = 45;

/** Money as whole agorot — two amounts are the same only when these are. */
export const agorot = (n: number): number => Math.round(n * 100);

export interface CardOrder {
  id: string;
  order_number: number;
  status: ChipOrderStatus;
  source: string;
  is_test: boolean;
  /** The total frozen on the order when it was saved. */
  total: number;
  /** All chips of the order (the sum of its apartment lines). */
  chips: number;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  card_status: CardStatus | null;
  card_env: CardEnv | null;
  card_page_request_uid: string | null;
  card_transaction_uid: string | null;
  card_failure_reason: string | null;
  /** Decision 3.5 (27/11/2026): the order page's agreement boxes are recorded
   *  on the order — "the details are correct" always, the renter commitment
   *  when the order has a renter row. A web order opens no payment window
   *  until both stand (consentMissing). */
  terms_accepted: boolean;
  renter_terms_ok: boolean;
}

const CARD_ORDER_SQL = `
  select o.id, o.order_number, o.status, o.source, o.is_test, o.total::float8 as total,
         (select coalesce(sum(i.chips_count), 0)::int from public.chip_order_items i where i.order_id = o.id) as chips,
         o.full_name, o.phone_e164, o.email,
         o.card_status, o.card_env, o.card_page_request_uid, o.card_transaction_uid, o.card_failure_reason,
         o.terms_accepted_at is not null as terms_accepted,
         (o.renter_terms_accepted_at is not null
           or not exists (select 1 from public.chip_order_holders h where h.order_id = o.id and h.role = 'tenant')) as renter_terms_ok
    from public.chip_orders o`;

/** What the payment step answers while consentMissing. */
export const CONSENT_REQUIRED = 'יש לסמן את תיבות האישור שמתחת לשדות התשלום לפני התשלום.';

/** A web order whose agreement boxes are not recorded (decision 3.5) — the
 *  server's own check of what the page's pay button already demands. */
export function consentMissing(order: Pick<CardOrder, 'source' | 'terms_accepted' | 'renter_terms_ok'>): boolean {
  return order.source === 'web' && (!order.terms_accepted || !order.renter_terms_ok);
}

/** The order behind a tracking token — the secret the browser that created the
 *  order holds — or null. */
export async function getCardOrderByToken(trackingToken: string): Promise<CardOrder | null> {
  if (!TOKEN_RE.test(trackingToken)) return null;
  return queryOne<CardOrder>(`${CARD_ORDER_SQL} where o.tracking_token = $1`, [trackingToken]);
}

/** The order a processor notice names by its number (the more_info we sent). */
export async function getCardOrderByNumber(orderNumber: number): Promise<CardOrder | null> {
  if (!Number.isSafeInteger(orderNumber) || orderNumber <= 0) return null;
  return queryOne<CardOrder>(`${CARD_ORDER_SQL} where o.order_number = $1`, [orderNumber]);
}

/**
 * Stores the payment session that was just opened for the order: a row of
 * chip_order_card_sessions, and the order's "latest session". Only while the
 * order still waits for payment, only on an order of the session's own kind:
 * the sandbox on a test order, production on a real one (the database refuses
 * anything else as well), and only while the order's total is still the
 * session's amount (a save that changed it while the session was being opened
 * wins). A new session clears the failure of the previous attempt. False =
 * nothing was stored: the session must not be used — the caller disables it.
 */
export async function setCardSession(
  orderId: string,
  s: { env: CardEnv; pageRequestUid: string; amount: number },
): Promise<boolean> {
  return withTransaction(async (client) => {
    const r = await client.query(
      `update public.chip_orders
          set card_provider = 'payplus', card_env = $2, card_status = 'started',
              card_page_request_uid = $3, card_session_at = now(),
              card_failure_reason = null, card_failed_at = null, updated_at = now()
        where id = $1 and status = 'pending_payment' and source in ('web', 'reception')
          and (source = 'web' or payment_method = 'card')
          and is_test = ($2 = 'sandbox')
          and round(total * 100) = round($4::numeric * 100)`,
      [orderId, s.env, s.pageRequestUid, s.amount],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    await client.query(
      `insert into public.chip_order_card_sessions (page_request_uid, order_id, env, amount) values ($1, $2, $3, $4)`,
      [s.pageRequestUid, orderId, s.env, s.amount],
    );
    return true;
  });
}

/** The order's recent payment sessions of an environment, newest first — the
 *  ones a charge may still arrive on (by default: opened in the last
 *  SESSION_LOOKUP_MINUTES). The purge and the reconciliation sweep pass a far
 *  wider window: before an order is deleted, EVERY session it ever had is asked about. */
export async function listRecentCardSessions(
  orderId: string,
  env: CardEnv,
  limit: number,
  withinMinutes: number = SESSION_LOOKUP_MINUTES,
): Promise<string[]> {
  const r = await query<{ page_request_uid: string }>(
    `select page_request_uid from public.chip_order_card_sessions
      where order_id = $1 and env = $2 and created_at > now() - make_interval(mins => $3)
      order by created_at desc limit $4`,
    [orderId, env, withinMinutes, limit],
  );
  return r.rows.map((row) => row.page_request_uid);
}

/** Orders that still wait for payment — web orders and reception card orders
 *  alike — and had a payment session of `env` that was opened between
 *  `minMinutes` and `maxMinutes` ago: the candidates of the reconciliation
 *  sweep (a charge whose callback was lost while the page or the window was
 *  closed). NEWEST session first: a lost charge is most likely recent, and the
 *  same abandoned orders do not take every run's places (an order the sweep no
 *  longer reaches is still looked up by the purge before it is deleted). */
export async function listPendingOrdersWithSessions(
  env: CardEnv,
  minMinutes: number,
  maxMinutes: number,
  limit: number,
): Promise<{ id: string; order_number: number }[]> {
  const r = await query<{ id: string; order_number: number }>(
    `select o.id, o.order_number
       from public.chip_orders o
      where o.status = 'pending_payment' and o.source in ('web', 'reception') and o.card_env = $1 and o.card_status <> 'paid'
        and exists (select 1 from public.chip_order_card_sessions s
                     where s.order_id = o.id and s.env = $1
                       and s.created_at < now() - make_interval(mins => $2)
                       and s.created_at > now() - make_interval(mins => $3))
      order by o.card_session_at desc nulls last
      limit $4`,
    [env, minMinutes, maxMinutes, limit],
  );
  return r.rows;
}

/** How many payment sessions the order ever had (any environment). */
export async function countCardSessions(orderId: string): Promise<number> {
  const r = await queryOne<{ n: number }>(`select count(*)::int as n from public.chip_order_card_sessions where order_id = $1`, [orderId]);
  return r?.n ?? 0;
}

export interface CardCharge {
  env: CardEnv;
  /** The order number the processor carries (the more_info we sent). */
  orderNumber: number;
  transactionUid: string;
  /** The payment session the charge went through. */
  pageRequestUid: string | null;
  amount: number;
  approvalNumber: string | null;
  last4: string | null;
}

export type CardPaymentOutcome =
  /** This call moved the order to paid. */
  | { kind: 'paid'; orderId: string }
  /** The same transaction again — nothing changed. */
  | { kind: 'already_paid'; orderId: string }
  /** A SECOND approved charge on an order that is already paid (or closed). */
  | { kind: 'duplicate_charge'; orderId: string }
  | { kind: 'unknown_order' }
  /** The order is not of the environment's kind (a sandbox charge and a real order, or the reverse). */
  | { kind: 'wrong_environment'; orderId: string }
  /** The charge names no payment session this server opened for this order. */
  | { kind: 'no_session'; orderId: string }
  | { kind: 'amount_mismatch'; orderId: string; expected: number };

/**
 * An APPROVED charge the processor reported → the order becomes paid, once.
 * One transaction, the order row locked: a callback and a lookup arriving
 * together, or the same callback twice, end as one 'paid' and the rest
 * 'already_paid'. The audit row is written in the same transaction, so a paid
 * order always has it. Nothing here trusts the browser — the caller got
 * `charge` from the processor.
 *
 * Refused, with the order left exactly as it was:
 *   - a sandbox charge for an order that is not a test order (and a
 *     production charge for a test order);
 *   - a charge that does not name a payment session this server opened for
 *     THIS order, in this environment;
 *   - an amount that is not the order's total.
 */
export async function recordCardPayment(
  charge: CardCharge,
  source: 'payplus_callback' | 'payplus_lookup',
  now: Date = new Date(),
): Promise<CardPaymentOutcome> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<{
        id: string; status: ChipOrderStatus; source: string; is_test: boolean; total: number;
        card_env: CardEnv | null; card_transaction_uid: string | null;
      }>(
        `select id, status, source, is_test, total::float8 as total, card_env, card_transaction_uid
           from public.chip_orders where order_number = $1 for update`,
        [charge.orderNumber],
      )
    ).rows[0];
    if (!o) return { kind: 'unknown_order' } as const;
    if ((o.source !== 'web' && o.source !== 'reception') || o.is_test !== (charge.env === 'sandbox') || (o.card_env !== null && o.card_env !== charge.env)) {
      return { kind: 'wrong_environment', orderId: o.id } as const;
    }
    const ours = charge.pageRequestUid
      ? (await client.query(
        `select 1 from public.chip_order_card_sessions where page_request_uid = $1 and order_id = $2 and env = $3`,
        [charge.pageRequestUid, o.id, charge.env],
      )).rowCount ?? 0
      : 0;
    if (ours === 0) return { kind: 'no_session', orderId: o.id } as const;
    if (o.card_transaction_uid === charge.transactionUid) return { kind: 'already_paid', orderId: o.id } as const;
    if (o.status !== 'pending_payment') return { kind: 'duplicate_charge', orderId: o.id } as const;
    if (agorot(charge.amount) !== agorot(o.total)) return { kind: 'amount_mismatch', orderId: o.id, expected: o.total } as const;

    // A web order starts its 72 working hours now; a reception order (paid at
    // the desk, 26/11/2026) has no due date — its chips are issued by the save
    // that follows, on the spot.
    await client.query(
      `update public.chip_orders
          set status = 'paid', paid_at = $2, due_at = case when source = 'reception' then null else $3::timestamptz end,
              card_status = 'paid', card_transaction_uid = $4, card_paid_amount = total, card_paid_at = $2,
              card_approval_number = $5, card_last4 = $6, card_page_request_uid = $7,
              card_failure_reason = null, card_failed_at = null, updated_at = now()
        where id = $1`,
      [o.id, now.toISOString(), chipOrderDueAt(now).toISOString(), charge.transactionUid,
        charge.approvalNumber?.slice(0, 40) ?? null, charge.last4, charge.pageRequestUid],
    );
    await writeAuditInTx(client, {
      actorUserId: null,
      action: 'paid',
      entityType: 'chip_order',
      entityId: o.id,
      metadata: {
        source, provider: 'payplus', env: charge.env, transaction_uid: charge.transactionUid,
        amount: charge.amount, approval_number: charge.approvalNumber,
      },
    });
    // The Morning document of the payment, queued with it (26/11/2026). A test
    // order (the sandbox) never gets one — enqueueDocumentInTx refuses it too.
    if (charge.env === 'production' && !o.is_test) {
      await enqueueDocumentInTx(client, {
        orderId: o.id,
        kind: 'invoice',
        paymentKey: `card:${charge.transactionUid}`,
        amount: o.total,
        method: 'card',
        details: { last4: charge.last4, approval_number: charge.approvalNumber, date: israelDate(now), provider: 'payplus' },
        // A card paid in the reception window (27/11/2026): the orderer's
        // details — the email Morning sends the document to — reach the order
        // only with the window's "שמור", seconds or minutes after the charge.
        // The invoice waits for that save (which releases it), at most this.
        ...(o.source === 'reception' ? { delayMinutes: RECEPTION_INVOICE_HOLD_MINUTES } : {}),
      });
    }
    return { kind: 'paid', orderId: o.id } as const;
  });
}

/**
 * A REFUSED attempt the processor reported: the reason is kept on the order,
 * which goes on waiting for payment. Only while it still waits, and only when
 * the attempt names one of the order's own payment sessions — a late "refused"
 * of an earlier attempt never touches an order that has been paid since, and
 * a refusal from anywhere else never touches an order at all.
 */
export async function recordCardFailure(
  f: { env: CardEnv; orderNumber: number; pageRequestUid: string | null; reason: string },
): Promise<boolean> {
  if (!f.pageRequestUid) return false;
  const reason = f.reason.replace(/\s+/g, ' ').trim().slice(0, 300) || 'העסקה נדחתה';
  const r = await query(
    `update public.chip_orders o
        set card_status = 'failed', card_failure_reason = $4, card_failed_at = now(), updated_at = now()
      where o.order_number = $1 and o.status = 'pending_payment' and o.source in ('web', 'reception')
        and o.card_env = $2 and o.card_status <> 'paid'
        and exists (select 1 from public.chip_order_card_sessions s
                     where s.page_request_uid = $3 and s.order_id = o.id and s.env = $2)`,
    [f.orderNumber, f.env, f.pageRequestUid, reason],
  );
  return (r.rowCount ?? 0) > 0;
}
