import 'server-only';
import { env } from '@/env';
import { logger } from '@/lib/logger';

// Grow (formerly Meshulam) Light API — the payment provider of /chip-order.
// Every endpoint, field and status code here is taken from the official docs
// (developers.grow.business, read 12/11/2026), nothing guessed:
//   createPaymentProcess   R/create-payment-process      (multipart/form-data)
//   getPaymentProcessInfo  R/get-payment-process-info    → R/response-get-payment-info
//   approveTransaction     R/approve-transaction-4       (the callback acknowledgement)
//   refundTransaction      R/refund-transaction          → R/response, R/errors
// All calls are server-side only (Grow blocks browser calls), multipart, and a
// reply is `{ status: 1|0, err: '' | { id, message }, data }`.
//
// processToken / transactionToken are secrets of OUR server: they are never
// put in a page, a log line or an API response to a browser.

export class GrowNotConfiguredError extends Error {
  constructor() {
    super('grow_not_configured');
    this.name = 'GrowNotConfiguredError';
  }
}

export class GrowApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'GrowApiError';
  }
}

/** Both identifiers AND an explicit environment — the order page may open
 *  (with the settings switch). GROW_ENV has no default on purpose: sandbox
 *  identifiers on the live site would turn test-card payments into "paid"
 *  orders, so the mode is always a conscious choice and shown in the settings. */
export function isGrowConfigured(): boolean {
  return Boolean(env.GROW_USER_ID && env.GROW_PAGE_CODE && env.GROW_ENV);
}

/** 'production' | 'sandbox' when configured, else null. */
export function growMode(): 'production' | 'sandbox' | null {
  return isGrowConfigured() ? (env.GROW_ENV ?? null) : null;
}

/** R/live-environment and R/testing-environment (only reached when configured). */
export function growBaseUrl(): string {
  return env.GROW_ENV === 'production'
    ? 'https://secure.meshulam.co.il/api/light/server/1.0'
    : 'https://sandbox.meshulam.co.il/api/light/server/1.0';
}

/** Origins the payment iframe may post messages from (R/postmessage's sample
 *  checks meshulam.co.il / sandbox.meshulam.co.il; the live API host is
 *  secure.meshulam.co.il, so all three are accepted). */
export const GROW_MESSAGE_ORIGINS = [
  'https://meshulam.co.il',
  'https://secure.meshulam.co.il',
  'https://sandbox.meshulam.co.il',
] as const;

/** "Do not include any special characters in any parameter" — free text only
 *  (names, descriptions) is reduced to letters, digits, spaces and hyphens. */
export function growSafeText(s: string, max = 100): string {
  return s
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} \-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

interface GrowReply {
  status: number | string;
  err: '' | { id?: number | string; message?: string } | string;
  data: unknown;
}

function errOf(reply: GrowReply): { code: number | null; message: string } {
  const e = reply.err;
  if (e && typeof e === 'object') {
    const code = e.id === undefined ? null : Number(e.id);
    return { code: Number.isFinite(code) ? code : null, message: String(e.message ?? 'grow_error') };
  }
  return { code: null, message: typeof e === 'string' && e ? e : 'grow_error' };
}

async function call(endpoint: string, fields: Record<string, string>): Promise<GrowReply> {
  if (!isGrowConfigured()) throw new GrowNotConfiguredError();
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  let res: Response;
  try {
    res = await fetch(`${growBaseUrl()}/${endpoint}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (err) {
    throw new GrowApiError(endpoint, null, `network: ${(err as Error).message}`);
  }
  const text = await res.text();
  let reply: GrowReply;
  try {
    reply = JSON.parse(text) as GrowReply;
  } catch {
    throw new GrowApiError(endpoint, null, `http_${res.status}_not_json`);
  }
  return reply;
}

const ok = (r: GrowReply) => Number(r.status) === 1;

// ── createPaymentProcess ───────────────────────────────────────────────────

export interface CreatePaymentInput {
  /** Decimal shekels (Grow's `sum` is not agorot). */
  sum: number;
  description: string;
  fullName: string;
  /** Israeli mobile, local form 05XXXXXXXX (Grow validates it). */
  phoneLocal: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  invoiceNotifyUrl: string;
  /** Our order id, echoed back in the callback's customFields.cField1. */
  orderId: string;
}

export interface CreatedPayment {
  processId: string;
  processToken: string;
  /** The payment page — shown in an iframe on /chip-order, valid ~10 minutes. */
  url: string;
}

export async function createPaymentProcess(input: CreatePaymentInput): Promise<CreatedPayment> {
  const reply = await call('createPaymentProcess', {
    pageCode: env.GROW_PAGE_CODE ?? '',
    userId: env.GROW_USER_ID ?? '',
    sum: input.sum.toFixed(2),
    description: growSafeText(input.description),
    'pageField[fullName]': growSafeText(input.fullName, 80),
    'pageField[phone]': input.phoneLocal,
    'pageField[email]': input.email,
    chargeType: '1',
    maxPaymentNum: '1',
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    notifyUrl: input.notifyUrl,
    invoiceNotifyUrl: input.invoiceNotifyUrl,
    cField1: input.orderId,
  });
  if (!ok(reply)) {
    const e = errOf(reply);
    throw new GrowApiError('createPaymentProcess', e.code, e.message);
  }
  const d = (reply.data ?? {}) as { processId?: unknown; processToken?: unknown; url?: unknown };
  if (!d.processId || !d.processToken || typeof d.url !== 'string') {
    throw new GrowApiError('createPaymentProcess', null, 'missing_process_fields');
  }
  return { processId: String(d.processId), processToken: String(d.processToken), url: d.url };
}

// ── getPaymentProcessInfo (the verification) ─────────────────────────────

export interface GrowTransaction {
  transactionId: string;
  transactionToken: string;
  asmachta: string | null;
  /** R/parameter-mapping: 2 = paid ("שולם"). */
  statusCode: number;
  sum: number;
}

export async function getPaymentProcessInfo(
  processId: string,
  processToken: string,
): Promise<{ processId: string; transactions: GrowTransaction[] }> {
  const reply = await call('getPaymentProcessInfo', {
    pageCode: env.GROW_PAGE_CODE ?? '',
    processId,
    processToken,
  });
  if (!ok(reply)) {
    const e = errOf(reply);
    throw new GrowApiError('getPaymentProcessInfo', e.code, e.message);
  }
  const d = (reply.data ?? {}) as { processId?: unknown; transactions?: unknown };
  const list = Array.isArray(d.transactions) ? d.transactions : [];
  return {
    processId: String(d.processId ?? ''),
    transactions: list.map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      return {
        transactionId: String(r.transactionId ?? ''),
        transactionToken: String(r.transactionToken ?? ''),
        asmachta: r.asmachta ? String(r.asmachta) : null,
        statusCode: Number(r.statusCode),
        sum: Number(r.sum),
      };
    }),
  };
}

/** The paid transaction of a process whose sum is exactly `expected`, or null. */
export function findPaidTransaction(txs: GrowTransaction[], expected: number): GrowTransaction | null {
  return (
    txs.find(
      (t) => t.statusCode === 2 && t.transactionId && Math.round(t.sum * 100) === Math.round(expected * 100),
    ) ?? null
  );
}

// ── approveTransaction (acknowledge the callback) ──────────────────────────

/** Sends back every field of the callback plus pageCode, as the docs require.
 *  Best-effort: the charge stands either way; Grow re-sends the callback when
 *  this does not arrive. Returns false on any failure (logged, never thrown). */
export async function approveTransaction(callbackFields: Record<string, string>): Promise<boolean> {
  try {
    const reply = await call('approveTransaction', { ...callbackFields, pageCode: env.GROW_PAGE_CODE ?? '' });
    if (ok(reply)) return true;
    logger.warn('[grow] approveTransaction refused', errOf(reply));
    return false;
  } catch (err) {
    logger.warn('[grow] approveTransaction failed', { error: (err as Error).message });
    return false;
  }
}

// ── refundTransaction ─────────────────────────────────────────────────────

export type RefundOutcome =
  | { kind: 'refunded' }
  /** 110: already paid out — the request waits for Grow's admin approval;
   *  anything else that is not a success: a person must finish the refund. */
  | { kind: 'manual'; code: number | null; message: string };

export async function refundTransaction(input: {
  transactionId: string;
  transactionToken: string;
  refundSum: number;
}): Promise<RefundOutcome> {
  try {
    const reply = await call('refundTransaction', {
      userId: env.GROW_USER_ID ?? '',
      pageCode: env.GROW_PAGE_CODE ?? '',
      transactionId: input.transactionId,
      transactionToken: input.transactionToken,
      refundSum: input.refundSum.toFixed(2),
    });
    if (ok(reply)) return { kind: 'refunded' };
    const e = errOf(reply);
    // 210 = "already refunded" — the money is back with the payer.
    if (e.code === 210) return { kind: 'refunded' };
    return { kind: 'manual', code: e.code, message: e.message };
  } catch (err) {
    return { kind: 'manual', code: null, message: (err as Error).message };
  }
}

// ── Callback body ─────────────────────────────────────────────────────────

/**
 * Grow posts the callback "the same way as you would send the data to
 * createPaymentProcess and NOT as JSON" (R/server-to-server-callback). Whether
 * the keys arrive flat (`processId`) or nested (`data[processId]`) is not
 * stated, so both are read; a JSON body is accepted too. Returns the flat
 * `data` fields as strings (customFields flattened to cFieldN).
 */
export function flattenGrowCallback(entries: Iterable<[string, unknown]>): Record<string, string> {
  const out: Record<string, string> = {};
  const nested = new Set<string>();
  for (const [rawKey, rawVal] of entries) {
    if (typeof rawVal !== 'string' && typeof rawVal !== 'number') continue;
    // data[processId] → processId · data[customFields][cField1] → cField1
    const m = /^(data\[)?([A-Za-z0-9_]+)\]?(?:\[([A-Za-z0-9_]+)\])?$/.exec(rawKey);
    if (!m) continue;
    const key = m[3] ?? m[2];
    if (key === 'data') continue;
    // The envelope's own status / err never overwrite a field of `data`.
    if (m[1]) nested.add(key);
    else if (nested.has(key)) continue;
    out[key] = String(rawVal);
  }
  return out;
}

export function flattenGrowJson(body: unknown): Record<string, string> {
  const root = (body ?? {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
    else if (k === 'customFields' && v && typeof v === 'object') {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof cv === 'string' || typeof cv === 'number') out[ck] = String(cv);
      }
    }
  }
  return out;
}
