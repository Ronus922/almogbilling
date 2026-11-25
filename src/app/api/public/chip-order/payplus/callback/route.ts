import { NextResponse, after } from 'next/server';
import { logger } from '@/lib/logger';
import { payloadFieldNames, payplusConfig, readPayPlusTransaction, verifyPayPlusCallback } from '@/lib/payplus/client';
import { applyPayPlusCallback } from '@/lib/chipOrders/cardPayment';
import { notifyChipOrder } from '@/lib/chipOrders/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order/payplus/callback — PayPlus's server-to-server
// notice of a transaction (the refURL_callback of the payment session; refused
// attempts arrive too — send_failure_callback).
//
// PUBLIC BY DESIGN (PayPlus calls it), and nothing is believed before the
// request is validated exactly as "Validate Requests Received from PayPlus"
// describes: `user-agent: PayPlus`, and a `hash` header equal to
// base64(HMAC-SHA256(our secret key, the JSON body)). Anything else is 401 and
// changes nothing — the same 401 whether or not PayPlus is configured here, so
// the answer tells a stranger nothing. The two headers are looked at before a
// byte of the body is read, and the body is read up to 64KB and no further.
//
// A validated notice is applied through applyPayPlusCallback, which:
//   - finds the order by the order number we put in more_info, AND requires
//     the transaction to belong to a payment session this server opened for
//     it. PayPlus's hosted-fields notice does not name its session (seen on
//     the sandbox, 25/11/2026): such a notice only makes the server ASK
//     PayPlus about the order's own sessions, and what PayPlus answers there
//     is what gets applied. If PayPlus cannot be asked right then, the answer
//     is 503 — nothing changed, and PayPlus may send the notice again;
//   - marks it paid only for an approved charge of EXACTLY the order's total,
//     on an order of the processor's own environment (a sandbox charge never
//     touches a real order);
//   - is idempotent — the same notice again changes nothing and sends nothing.
// The audit row is written with the transition, in one transaction; the
// "received & paid" message follows only the call that made it.
//
// The body also carries the card's expiry, its BIN and the holder's ID number.
// Only a whitelist of fields is read (readPayPlusTransaction); the body is
// never stored and never logged (and never sent with a Sentry event —
// src/lib/sentry-options.ts).

const MAX_BODY_BYTES = 64 * 1024;
const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });

/** The body, or null when it is larger than `max` (the rest is not read). */
async function readBody(req: Request, max: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request) {
  const cfg = payplusConfig();
  const userAgent = req.headers.get('user-agent');
  const hash = req.headers.get('hash');
  // Cheap refusals first: nothing is read for a caller that is plainly not PayPlus.
  if (!cfg || userAgent !== 'PayPlus' || !hash) return unauthorized();
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return unauthorized();

  const raw = await readBody(req, MAX_BODY_BYTES).catch(() => null);
  if (!raw) return unauthorized();

  const checked = verifyPayPlusCallback(cfg.secretKey, raw, { userAgent, hash });
  if (!checked.ok) {
    // Why it failed — never the hash, the body or a key.
    logger.warn('[chip-order] payplus callback rejected', { reason: checked.reason, bytes: raw.byteLength });
    return unauthorized();
  }

  const tx = readPayPlusTransaction(checked.body);
  if (!tx) {
    logger.warn('[chip-order] payplus callback without a readable transaction');
    return NextResponse.json({ ok: true, ignored: 'unreadable' });
  }

  if (tx.pageRequestUid === null) {
    // Which fields the notice has — their names only, never a value.
    logger.warn('[chip-order] payplus callback names no payment session — asking PayPlus', { fields: payloadFieldNames(checked.body) });
  }
  const applied = await applyPayPlusCallback(cfg, tx);
  if (applied.kind === 'unconfirmed') return NextResponse.json({ ok: false, error: 'not confirmed yet' }, { status: 503 });
  if (applied.kind === 'paid' && applied.transitioned) {
    after(() => notifyChipOrder(applied.orderId, 'paid'));
  }
  return NextResponse.json({ ok: true });
}
