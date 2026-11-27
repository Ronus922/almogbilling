import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';

// The Morning documents of chip orders — the queue and the record
// (migration 20261125222603, table chip_order_documents). The issuer is
// src/lib/chipOrders/documents.ts; this module only reads and writes rows.
//
// THE RULES THIS MODULE KEEPS
//   - A row is written in the SAME transaction as the money movement it
//     documents (enqueueDocumentInTx takes the caller's client).
//   - One row per payment_key, ever (UNIQUE): a payment reported twice, or the
//     same refund recorded twice, can never queue a second document.
//   - A TEST order never gets a row — refused here, whatever the caller asks.

export type DocKind = 'invoice' | 'credit';
export type DocStatus = 'pending' | 'issuing' | 'issued' | 'failed';
export type DocMethod = 'card' | 'cash' | 'bank_transfer';

export interface IssuedMorningDoc {
  type: number;
  id: string;
  number: string;
  url: string | null;
}

/** A short unique reference printed on the document ("CHXXXXXXXX"). */
function newRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = 'CH';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export interface EnqueueDocument {
  orderId: string;
  kind: DocKind;
  /** card:<transaction uid> · reception:<order id> · refund:<refund uid> · cancel:<order id> */
  paymentKey: string;
  amount: number;
  method: DocMethod;
  /** last4, approval number, the payment / refund date, the refund's id … never card data. */
  details?: Record<string, unknown>;
  /** kind 'credit': the invoice row it cancels (null when none exists). */
  creditOf?: string | null;
  /** Not before this many minutes (27/11/2026): the invoice of a card payment
   *  made in the reception window waits for that window's "שמור", which
   *  completes the orderer's details — the email Morning sends it to. The save
   *  (and "ביטול וזיכוי") release it at once; otherwise it is issued then. */
  delayMinutes?: number;
}

/**
 * Queues the document of a money movement, inside the caller's transaction.
 * Returns the row id, or null when nothing was queued: a test order (never a
 * document), or a payment_key that already has its row (idempotent).
 */
export async function enqueueDocumentInTx(client: PoolClient, e: EnqueueDocument): Promise<string | null> {
  const o = (await client.query<{ is_test: boolean }>(`select is_test from public.chip_orders where id = $1`, [e.orderId])).rows[0];
  if (!o || o.is_test) return null;
  const r = await client.query<{ id: string }>(
    `insert into public.chip_order_documents (order_id, kind, payment_key, ref, amount, payment_method, details, credit_of, next_attempt_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now() + make_interval(mins => $9))
     on conflict (payment_key) do nothing
     returning id`,
    [e.orderId, e.kind, e.paymentKey, newRef(), e.amount, e.method, JSON.stringify(e.details ?? {}), e.creditOf ?? null,
      Math.max(0, Math.floor(e.delayMinutes ?? 0))],
  );
  return r.rows[0]?.id ?? null;
}

/** The invoice row of an order (its first payment document), or null. */
export async function getInvoiceRowOfOrderInTx(client: PoolClient, orderId: string): Promise<{ id: string; status: DocStatus } | null> {
  const r = await client.query<{ id: string; status: DocStatus }>(
    `select id, status from public.chip_order_documents where order_id = $1 and kind = 'invoice' order by created_at limit 1`,
    [orderId],
  );
  return r.rows[0] ?? null;
}

export interface ClaimedDocument {
  id: string;
  order_id: string;
  kind: DocKind;
  payment_key: string;
  ref: string;
  amount: number;
  payment_method: DocMethod;
  attempts: number;
  credit_of: string | null;
  details: Record<string, unknown>;
  morning_docs: IssuedMorningDoc[];
  created_at: string;
  /** An earlier attempt may have reached Morning: the row was found 'issuing'
   *  (a run that never finished), or it carries the error of an earlier
   *  attempt — kept through "הפק חשבונית שוב", which resets `attempts` (only
   *  markDocumentIssued clears it). Before issuing again, Morning is searched
   *  for what that attempt may have created. */
  recovering: boolean;
  /** This run's claim (claimed_at, full precision). Renewed right before the
   *  row is worked on (renewDocumentClaim) — a run that lost the row to
   *  another run after the stale window skips it instead of issuing twice. */
  claim: string;
}

/** Due rows → 'issuing' (one attempt counted). A row stuck in 'issuing' longer
 *  than `staleMinutes` is claimed again, marked `recovering` — and so is a row
 *  with the error of an earlier attempt (a timeout, or a reply that could not
 *  be read, may come after Morning created the document). */
export async function claimDueDocuments(limit: number, staleMinutes = 10, orderId: string | null = null): Promise<ClaimedDocument[]> {
  const r = await query<ClaimedDocument>(
    `with picked as (
       select id, status as was from public.chip_order_documents
        where ((status = 'pending' and next_attempt_at <= now())
           or (status = 'issuing' and claimed_at < now() - make_interval(mins => $2)))
          and ($3::uuid is null or order_id = $3::uuid)
        -- An invoice before the credit that cancels it (both due at once).
        order by next_attempt_at, created_at
        limit $1
        for update skip locked
     )
     update public.chip_order_documents d
        set status = 'issuing', claimed_at = now(), attempts = d.attempts + 1, updated_at = now()
       from picked
      where d.id = picked.id
     returning d.id, d.order_id, d.kind, d.payment_key, d.ref, d.amount::float8 as amount, d.payment_method,
               d.attempts, d.credit_of, d.details, d.morning_docs, d.created_at,
               (picked.was = 'issuing' or d.last_error is not null) as recovering,
               d.claimed_at::text as claim`,
    [limit, staleMinutes, orderId],
  );
  return r.rows;
}

/**
 * Still ours? Re-stamps the claim right before the row is worked on, so the
 * stale window (10 minutes) counts from now and not from the batch claim. Null
 * = another run took the row over (or finished it): the caller must skip it.
 */
export async function renewDocumentClaim(id: string, claim: string): Promise<string | null> {
  const r = await queryOne<{ claim: string }>(
    `update public.chip_order_documents
        set claimed_at = clock_timestamp(), updated_at = now()
      where id = $1 and status = 'issuing' and claimed_at = $2::timestamptz
      returning claimed_at::text as claim`,
    [id, claim],
  );
  return r?.claim ?? null;
}

/** Is anything due now? (cheap — the triggers call it before claiming). */
export async function hasDueDocuments(staleMinutes = 10, orderId: string | null = null): Promise<boolean> {
  const r = await queryOne<{ due: boolean }>(
    `select exists (
       select 1 from public.chip_order_documents
        where ((status = 'pending' and next_attempt_at <= now())
           or (status = 'issuing' and claimed_at < now() - make_interval(mins => $1)))
          and ($2::uuid is null or order_id = $2::uuid)
     ) as due`,
    [staleMinutes, orderId],
  );
  return r?.due === true;
}

/** Part of a multi-document row was issued (a credit's 330, before its receipt). */
export async function recordDocumentProgress(id: string, docs: IssuedMorningDoc[]): Promise<void> {
  await query(
    `update public.chip_order_documents set morning_docs = $2::jsonb, updated_at = now() where id = $1 and status = 'issuing'`,
    [id, JSON.stringify(docs)],
  );
}

/** Whether Morning was asked to email a document (27/11/2026): to the address
 *  on the request (`sent`), or not at all — the order has no email
 *  (`no_email`). Undefined = not known (a document found again in Morning
 *  after a crash): nothing is recorded. */
export type DocumentEmail = { status: 'sent'; to: string } | { status: 'no_email' };

/** Issued. An invoice's first document is mirrored onto the order
 *  (invoice_number / invoice_url) — the number and link the order shows. */
export async function markDocumentIssued(id: string, docs: IssuedMorningDoc[], email?: DocumentEmail): Promise<void> {
  await withTransaction(async (client) => {
    const row = (
      await client.query<{ order_id: string; kind: DocKind }>(
        `update public.chip_order_documents
            set status = 'issued', issued_at = now(), claimed_at = null, last_error = null,
                morning_docs = $2::jsonb,
                email_status = coalesce($3, email_status), email_to = case when $3 is null then email_to else $4 end,
                updated_at = now()
          where id = $1 and status = 'issuing'
          returning order_id, kind`,
        [id, JSON.stringify(docs), email?.status ?? null, email?.status === 'sent' ? email.to.slice(0, 254) : null],
      )
    ).rows[0];
    if (row?.kind === 'invoice' && docs[0]) {
      await client.query(
        `update public.chip_orders set invoice_number = $2, invoice_url = $3, updated_at = now()
          where id = $1 and not is_test and invoice_number is null`,
        [row.order_id, docs[0].number, docs[0].url],
      );
    }
  });
}

/** Back to the queue: try again at `nextAt` (the attempt stays counted). */
export async function rescheduleDocument(id: string, error: string, nextAt: Date): Promise<void> {
  await query(
    `update public.chip_order_documents
        set status = 'pending', claimed_at = null, last_error = $2, next_attempt_at = $3, updated_at = now()
      where id = $1 and status = 'issuing'`,
    [id, error.slice(0, 500), nextAt.toISOString()],
  );
}

/** Not this time, and not the document's fault (its original is still being
 *  issued): back to the queue WITHOUT counting the attempt. */
export async function postponeDocument(id: string, minutes: number): Promise<void> {
  await query(
    `update public.chip_order_documents
        set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0),
            next_attempt_at = now() + make_interval(mins => $2), updated_at = now()
      where id = $1 and status = 'issuing'`,
    [id, minutes],
  );
}

/** Failed for good (until "הפק חשבונית שוב"). True only for the call that made it so. */
export async function failDocument(id: string, error: string): Promise<boolean> {
  const r = await query(
    `update public.chip_order_documents
        set status = 'failed', claimed_at = null, last_error = $2, updated_at = now()
      where id = $1 and status = 'issuing'`,
    [id, error.slice(0, 500)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** "הפק חשבונית שוב": the order's failed rows go back to the queue, now, with
 *  their attempts reset. Their last_error stays: the next claim marks them
 *  `recovering`, so Morning is searched before anything is posted again (the
 *  failed attempt may have created the document). Returns how many. */
/** "ביטול וזיכוי" (27/11/2026): every document of the order that waits is
 *  due NOW — an invoice held for the reception window's save, a row waiting
 *  out its backoff — and a failed one goes back to the queue (as "הפק חשבונית
 *  שוב" does: attempts reset, Morning searched first). Returns how many. */
export async function releaseDocumentsOfOrder(orderId: string): Promise<number> {
  const r = await query(
    `update public.chip_order_documents
        set status = 'pending', next_attempt_at = now(),
            attempts = case when status = 'failed' then 0 else attempts end, updated_at = now()
      where order_id = $1 and (status = 'failed' or (status = 'pending' and next_attempt_at > now()))`,
    [orderId],
  );
  return r.rowCount ?? 0;
}

/** The reception window's "שמור" completed the orderer of a card-paid order:
 *  its held invoice is due now (inside the save's transaction). */
export async function releaseHeldInvoiceInTx(client: PoolClient, orderId: string): Promise<void> {
  await client.query(
    `update public.chip_order_documents set next_attempt_at = now(), updated_at = now()
      where order_id = $1 and kind = 'invoice' and status = 'pending' and next_attempt_at > now()`,
    [orderId],
  );
}

export async function retryFailedDocuments(orderId: string): Promise<number> {
  const r = await query(
    `update public.chip_order_documents
        set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
      where order_id = $1 and status = 'failed'`,
    [orderId],
  );
  return r.rowCount ?? 0;
}

export interface DocumentSource {
  order: {
    id: string;
    order_number: number;
    is_test: boolean;
    full_name: string;
    email: string | null;
    phone_e164: string | null;
    address_street: string | null;
    address_city: string | null;
    address_zip: string | null;
    total: number;
  };
  items: { apartment_number: string; chips_count: number; unit_price: number; threshold: number; price_above: number }[];
  /** kind 'credit': the invoice row it cancels. */
  original: { id: string; status: DocStatus; morning_docs: IssuedMorningDoc[] } | null;
}

/** Everything the body of a row's document is built from. */
export async function getDocumentSource(row: Pick<ClaimedDocument, 'order_id' | 'credit_of'>): Promise<DocumentSource | null> {
  const order = await queryOne<DocumentSource['order']>(
    `select id, order_number, is_test, full_name, email, phone_e164, address_street, address_city, address_zip, total::float8 as total
       from public.chip_orders where id = $1`,
    [row.order_id],
  );
  if (!order) return null;
  const items = (
    await query<DocumentSource['items'][number]>(
      `select apartment_number, chips_count, unit_price::float8 as unit_price, threshold, price_above::float8 as price_above
         from public.chip_order_items where order_id = $1 order by apartment_number`,
      [row.order_id],
    )
  ).rows;
  const original = row.credit_of
    ? await queryOne<{ id: string; status: DocStatus; morning_docs: IssuedMorningDoc[] }>(
      `select id, status, morning_docs from public.chip_order_documents where id = $1`,
      [row.credit_of],
    )
    : null;
  return { order, items, original };
}

export interface OrderDocumentSummary {
  kind: DocKind;
  status: DocStatus;
  amount: number;
  number: string | null;
  url: string | null;
  last_error: string | null;
  attempts: number;
  /** Every Morning document of the row (a credit has two: 330 + 400). */
  numbers: string[];
  email_status: 'sent' | 'no_email' | null;
  email_to: string | null;
}

/** The documents of these orders, oldest first, keyed by order id. */
export async function listDocumentsOfOrders(orderIds: string[]): Promise<Map<string, OrderDocumentSummary[]>> {
  const out = new Map<string, OrderDocumentSummary[]>();
  if (orderIds.length === 0) return out;
  const r = await query<OrderDocumentSummary & { order_id: string }>(
    `select order_id, kind, status, amount::float8 as amount,
            morning_docs->0->>'number' as number, morning_docs->0->>'url' as url, last_error, attempts,
            coalesce((select array_agg(x->>'number') from jsonb_array_elements(morning_docs) x), '{}') as numbers,
            email_status, email_to
       from public.chip_order_documents where order_id = any($1::uuid[])
      order by created_at`,
    [orderIds],
  );
  for (const { order_id, ...doc } of r.rows) {
    const list = out.get(order_id) ?? [];
    list.push(doc);
    out.set(order_id, list);
  }
  return out;
}
