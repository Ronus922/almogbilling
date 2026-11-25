import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/env';

// PayPlus — the card processor of the chips module (hosted fields).
// Everything here is taken from the official docs (docs.payplus.co.il, read
// 25/11/2026) and from PayPlus's own hosted-fields sample
// (github.com/PayPlus-Gateway/hosted-fields-sample), nothing guessed:
//   PaymentPages/generateLink  R/post_paymentpages-generatelink — opens a
//       payment page request. The reference does not list a hosted-fields
//       flag; the sample's payment.php sends `hosted_fields: true` and
//       `refURL_origin` (the origin of the page that mounts the fields), and
//       the reply then carries `hosted_fields_uuid` next to `page_request_uid`.
//   PaymentPages/ipn           R/post_paymentpages-ipn — the server-side
//       lookup of a payment page request (what happened on it).
//   The callback               R/validate-requests-received-from-payplus —
//       header `user-agent: PayPlus` and header `hash` = base64 of
//       HMAC-SHA256(secret key, the JSON body).
// Authentication: the `api-key` and `secret-key` headers (the reference).
//
// THE KEYS ARE SERVER-ONLY. They are read here, sent to PayPlus in two request
// headers, and go nowhere else: not into a response to a browser, not into a
// log line, not into an error message (PayPlusApiError carries PayPlus's own
// text, scrubbed of both values in case the far side ever echoes one).

export type PayPlusMode = 'sandbox' | 'production';

/** docs: "PayPlus REST API Environment URLs". The browser SDK takes the same
 *  host as its `origin` (the hosted-field frames are served from it). */
const ORIGIN: Record<PayPlusMode, string> = {
  sandbox: 'https://restapidev.payplus.co.il',
  production: 'https://restapi.payplus.co.il',
};
const API_PATH = '/api/v1.0';
const TIMEOUT_MS = 20_000;

export interface PayPlusConfig {
  mode: PayPlusMode;
  /** The API host, which is also the `origin` the browser SDK needs. */
  origin: string;
  apiKey: string;
  secretKey: string;
  pageUid: string;
}

/** The configuration of the mode PAYPLUS_MODE names — null when the mode is
 *  unset or any of ITS three values is missing (the other mode's values are
 *  never used as a fallback). */
export function payplusConfig(): PayPlusConfig | null {
  const mode = env.PAYPLUS_MODE;
  if (mode !== 'sandbox' && mode !== 'production') return null;
  const apiKey = mode === 'sandbox' ? env.PAYPLUS_DEV_API_KEY : env.PAYPLUS_PROD_API_KEY;
  const secretKey = mode === 'sandbox' ? env.PAYPLUS_DEV_SECRET_KEY : env.PAYPLUS_PROD_SECRET_KEY;
  const pageUid = mode === 'sandbox' ? env.PAYPLUS_DEV_PAGE_UID : env.PAYPLUS_PROD_PAGE_UID;
  if (!apiKey || !secretKey || !pageUid) return null;
  return { mode, origin: ORIGIN[mode], apiKey, secretKey, pageUid };
}

export class PayPlusApiError extends Error {
  constructor(
    readonly endpoint: string,
    /** HTTP status, or 0 when no reply arrived (network, timeout). */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PayPlusApiError';
  }
}

/** PayPlus's text for a log line: never longer than 300 characters and never
 *  holding either key. */
function safeText(cfg: PayPlusConfig, text: string): string {
  let out = text;
  for (const secret of [cfg.apiKey, cfg.secretKey]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function post(cfg: PayPlusConfig, endpoint: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${cfg.origin}${API_PATH}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'almog-billing/1.0',
        'api-key': cfg.apiKey,
        'secret-key': cfg.secretKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    // The cause may be a fetch error object; only its name is kept.
    throw new PayPlusApiError(endpoint, 0, `no reply from PayPlus (${(e as Error).name})`);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const j = (json ?? {}) as { message?: unknown; results?: { description?: unknown } };
    const said = typeof j.message === 'string' ? j.message
      : typeof j.results?.description === 'string' ? j.results.description
        : text;
    throw new PayPlusApiError(endpoint, res.status, safeText(cfg, said || `HTTP ${res.status}`));
  }
  return json;
}

// ── generateLink (hosted fields) ───────────────────────────────────────────

export interface HostedFieldsSessionInput {
  /** The amount the SERVER computed from the saved order. */
  amount: number;
  orderNumber: number;
  /** The origin of the page that mounts the fields (scheme + host). */
  pageOrigin: string;
  /** Our public callback URL. */
  callbackUrl: string;
  customer: { name: string; email: string; phone: string | null };
}

export interface HostedFieldsSession {
  pageRequestUid: string;
  hostedFieldsUuid: string;
}

/** The body of generateLink for one order — exported for the tests: a regular
 *  charge (J4), one payment, the order number in more_info, hosted fields. */
export function hostedFieldsRequestBody(cfg: PayPlusConfig, input: HostedFieldsSessionInput): Record<string, unknown> {
  return {
    payment_page_uid: cfg.pageUid,
    charge_method: 1, // 1 = Charge (J4)
    amount: input.amount,
    currency_code: 'ILS',
    language_code: 'he',
    // Our own messages go out when the order turns paid; PayPlus sends none.
    sendEmailApproval: false,
    sendEmailFailure: false,
    // One payment, always: no instalments, no credit plan, no field for them.
    payments: 1,
    payments_selected: 1,
    payments_credit: false,
    hide_payments_field: true,
    create_token: false,
    // No invoice / receipt from PayPlus: documents are a separate, later step.
    initial_invoice: false,
    // Card only — no Bit, no wallets, no other tab.
    charge_default: 'credit-card',
    hide_other_charge_methods: true,
    allowed_charge_methods: ['credit-card'],
    expiry_datetime: String(PAGE_EXPIRY_MINUTES),
    more_info: String(input.orderNumber),
    refURL_callback: input.callbackUrl,
    send_failure_callback: true,
    // Hosted fields (PayPlus's sample, payment.php).
    hosted_fields: true,
    refURL_origin: input.pageOrigin,
    customer: {
      customer_name: input.customer.name,
      email: input.customer.email,
      ...(input.customer.phone ? { phone: input.customer.phone } : {}),
    },
  };
}

/** Minutes a payment page request lives (generateLink `expiry_datetime`). */
export const PAGE_EXPIRY_MINUTES = 30;

const UID_RE = /^[0-9a-fA-F-]{16,64}$/;

export async function createHostedFieldsSession(cfg: PayPlusConfig, input: HostedFieldsSessionInput): Promise<HostedFieldsSession> {
  const endpoint = '/PaymentPages/generateLink';
  const json = (await post(cfg, endpoint, hostedFieldsRequestBody(cfg, input))) as {
    results?: { status?: unknown; description?: unknown };
    data?: { page_request_uid?: unknown; hosted_fields_uuid?: unknown };
  } | null;
  const pageRequestUid = json?.data?.page_request_uid;
  const hostedFieldsUuid = json?.data?.hosted_fields_uuid;
  if (json?.results?.status !== 'success' || typeof pageRequestUid !== 'string' || !UID_RE.test(pageRequestUid)) {
    const said = typeof json?.results?.description === 'string' ? json.results.description : 'unexpected reply';
    throw new PayPlusApiError(endpoint, 200, safeText(cfg, said));
  }
  if (typeof hostedFieldsUuid !== 'string' || !UID_RE.test(hostedFieldsUuid)) {
    // The account answered, but without the hosted-fields identifier: hosted
    // fields are not enabled for this payment page.
    throw new PayPlusApiError(endpoint, 200, 'the reply carries no hosted_fields_uuid (hosted fields not enabled for this payment page?)');
  }
  return { pageRequestUid, hostedFieldsUuid };
}

// ── A transaction, as PayPlus reports it ───────────────────────────────────

export interface PayPlusTransaction {
  /** transaction.uid */
  uid: string;
  /** transaction.payment_request_uid — the payment session the charge went through. */
  pageRequestUid: string | null;
  /** The kind of transaction, lower-cased: 'charge' for a J4 charge, 'refund', …
   *  null when the payload does not say. */
  type: string | null;
  /** '000' = approved. */
  statusCode: string;
  amount: number;
  /** '' when the payload does not say. */
  currency: string;
  approvalNumber: string | null;
  /** The more_info we sent — the order number. */
  moreInfo: string | null;
  payments: number | null;
  /** The last four digits only. Nothing else of the card is read. */
  last4: string | null;
  /** PayPlus's text for a refused charge, when it sends one. */
  statusDescription: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A status code as PayPlus writes it: three digits ('000'), also when it
 *  arrives as the number 0 or as '0'. Anything else is kept as it came. */
const statusCodeOf = (v: unknown): string | null => {
  const raw = str(v);
  if (raw === null) return null;
  return /^\d{1,3}$/.test(raw) ? raw.padStart(3, '0') : raw.slice(0, 20);
};

/**
 * Reads ONE transaction out of a PayPlus payload — the callback's body or one
 * entry of the lookup's reply — by a whitelist of fields. The payload also
 * holds the card's expiry, its BIN and the holder's ID number: none of them is
 * read, so none of them can reach a table or a log. Null when the payload
 * holds no transaction this server can use (no id of a sane length, no status
 * code, no amount).
 */
export function readPayPlusTransaction(payload: unknown): PayPlusTransaction | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const t = p.transaction && typeof p.transaction === 'object' ? obj(p.transaction) : p;
  const uid = str(t.uid) ?? str(t.transaction_uid);
  const statusCode = statusCodeOf(t.status_code);
  const amount = typeof t.amount === 'number' ? t.amount : typeof t.amount === 'string' && t.amount.trim() ? Number(t.amount) : NaN;
  if (!uid || uid.length < 8 || uid.length > 80 || !statusCode || !Number.isFinite(amount)) return null;
  const card = Object.keys(obj(obj(p.data).card_information)).length > 0 ? obj(obj(p.data).card_information) : obj(t.card_information);
  const four = str(card.four_digits) ?? str(t.four_digits);
  const payments = obj(t.payments).number_of_payments ?? t.number_of_payments;
  const pageRequestUid = str(t.payment_request_uid) ?? str(t.page_request_uid);
  // The KIND of transaction is transaction_type ("Charge"). transaction.type is
  // something else (where it was made — "internal_page") and is never read as the kind.
  const type = str(p.transaction_type) ?? str(t.transaction_type);
  const paymentsCount = typeof payments === 'number' ? payments : typeof payments === 'string' && payments.trim() ? Number(payments) : NaN;
  return {
    uid,
    pageRequestUid: pageRequestUid && pageRequestUid.length >= 8 && pageRequestUid.length <= 80 ? pageRequestUid : null,
    type: type ? type.toLowerCase().slice(0, 30) : null,
    statusCode,
    amount,
    currency: (str(t.currency) ?? str(t.currency_code) ?? '').toUpperCase().slice(0, 10),
    approvalNumber: str(t.approval_number) ?? str(t.approval_num),
    moreInfo: str(t.more_info),
    payments: Number.isFinite(paymentsCount) ? paymentsCount : null,
    last4: four && /^\d{4}$/.test(four) ? four : null,
    statusDescription: str(t.status_description),
  };
}

/** An approved regular charge: PayPlus says "Charge" and status 000. A payload
 *  that does not name its kind is NOT one (see applyPayPlusTransaction). */
export function isApprovedCharge(t: PayPlusTransaction): boolean {
  return t.statusCode === '000' && t.type === 'charge';
}

// ── The callback's signature ───────────────────────────────────────────────

function hmacB64(secret: string, message: Buffer | string): Buffer {
  return Buffer.from(createHmac('sha256', secret).update(message).digest('base64'));
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * "Validate Requests Received from PayPlus": the request must carry
 * `user-agent: PayPlus` and a `hash` header equal to base64(HMAC-SHA256(secret
 * key, the JSON body)). The docs' sample signs `JSON.stringify(body)` of the
 * parsed body, so both are accepted: the BYTES exactly as they arrived, and
 * the body re-serialized — each is an HMAC under OUR secret key over what was
 * received, so neither can be forged without the key. Compared in constant
 * time. Returns the parsed body on success.
 */
export function verifyPayPlusCallback(
  secretKey: string,
  rawBody: Buffer,
  headers: { userAgent: string | null; hash: string | null },
): { ok: true; body: unknown } | { ok: false; reason: 'user_agent' | 'no_hash' | 'no_body' | 'bad_json' | 'bad_hash' } {
  if (headers.userAgent !== 'PayPlus') return { ok: false, reason: 'user_agent' };
  const hash = headers.hash?.trim();
  if (!hash) return { ok: false, reason: 'no_hash' };
  if (rawBody.byteLength === 0) return { ok: false, reason: 'no_body' };
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad_json' };
  const got = Buffer.from(hash);
  if (sameBytes(got, hmacB64(secretKey, rawBody))) return { ok: true, body };
  // The re-serialized form. A body nested deeper than the serializer can walk
  // throws there — that is a refusal, never an exception out of this function.
  let canonical: string | null = null;
  try {
    canonical = JSON.stringify(body);
  } catch {
    canonical = null;
  }
  if (canonical !== null && sameBytes(got, hmacB64(secretKey, canonical))) return { ok: true, body };
  return { ok: false, reason: 'bad_hash' };
}

// ── The server-side lookup ─────────────────────────────────────────────────

export type PayPlusLookup =
  /** PayPlus answered: every transaction of the payment session (possibly none). */
  | { kind: 'transactions'; transactions: PayPlusTransaction[] }
  /** PayPlus refused or was not understood — this says NOTHING about a charge. */
  | { kind: 'unknown'; status: number; message: string };

/**
 * What PayPlus knows about a payment session (PaymentPages/ipn). The caller
 * picks the approved charge of the right amount. 'unknown' is never read as
 * "nothing was charged".
 */
export async function lookupPaymentRequest(cfg: PayPlusConfig, pageRequestUid: string): Promise<PayPlusLookup> {
  const endpoint = '/PaymentPages/ipn';
  let json: unknown;
  try {
    json = await post(cfg, endpoint, { payment_request_uid: pageRequestUid, related_transaction: true });
  } catch (e) {
    if (e instanceof PayPlusApiError) return { kind: 'unknown', status: e.status, message: e.message };
    throw e;
  }
  const j = obj(json);
  const results = obj(j.results);
  if (typeof results.status === 'string' && results.status !== 'success') {
    return { kind: 'unknown', status: 200, message: safeText(cfg, str(results.description) ?? results.status) };
  }
  const out: PayPlusTransaction[] = [];
  const seen = new Set<string>();
  const take = (node: unknown) => {
    const tx = readPayPlusTransaction(node);
    if (tx && !seen.has(tx.uid)) {
      seen.add(tx.uid);
      out.push(tx);
    }
  };
  take(j.data);
  take(j);
  const d = obj(j.data);
  for (const key of ['related_transactions', 'transactions']) {
    const list = d[key];
    if (Array.isArray(list)) for (const item of list.slice(0, 50)) take(item);
  }
  return { kind: 'transactions', transactions: out };
}
