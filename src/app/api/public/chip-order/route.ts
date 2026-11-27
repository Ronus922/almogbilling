import { NextResponse, after } from 'next/server';
import { createHash } from 'node:crypto';
import { chipOrderSubmitSchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { toPortalE164 } from '@/lib/portal/phone';
import { logger } from '@/lib/logger';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import {
  ChipOrderStateError, chipOrderTotalOf, createChipOrder, updatePendingChipOrder,
  type NewOrderRow, type ReusedLease,
} from '@/lib/db/chipOrders';
import { agorot, getCardOrderByToken } from '@/lib/db/chipOrderCard';
import { uploadChipOrderLease, removeChipOrderLeases } from '@/lib/storage/chipOrderLeaseStorage';
import { isLeaseError, readLease } from '@/lib/chipOrders/lease';
import { CHIP_ORDER_APT_LIMIT_MESSAGE, CHIP_ORDER_LIMITS, needsLease } from '@/lib/chipOrders/model';
import { chipOrdersOpen, CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { cardConfigFor, lookupCardPayment, lookupConfigFor } from '@/lib/chipOrders/cardPayment';
import { disablePaymentRequest } from '@/lib/payplus/client';
import { afterOrderPaid } from '@/lib/chipOrders/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order — the order form of /chip-order, multipart:
//   order     = JSON (chipOrderSubmitSchema — the contact block, the address in
//               three parts, and the ROWS: one person each — 20/11/2026)
//   lease_<i> = a NEW lease of row i (renter rows only; a row that keeps the
//               lease the server already holds sends its `leaseKey` instead)
//
// ONE FORM, NO PHONE CODE (26/11/2026). The form saves its order as soon as the
// details are complete, so the card fields (and the wallet buttons) can be
// live before the one pay button is pressed: a card payment session can only
// be opened for an order that exists, at an amount the server computed from
// it. Without `trackingToken` this CREATES the order; with it, it REPLACES the
// content of the order that token names — only while that order still waits
// for payment, nothing was charged on it, and it is of the request's kind
// (test / real). The agreement boxes gate the payment in the page, not this save.
//
// THE PRICE IS COMPUTED HERE from the settings, never read from the browser:
// total = all chips × the price of the settings. Up to
// CHIP_ORDER_LIMITS.maxChipsPerApartment chips per apartment, over all its
// rows. When an update changes the total of an order that already had a
// payment session, PayPlus is asked first whether anything was charged on it:
// a charge pays the order now (409 state 'paid'), and an unknown answer
// refuses the change (502) — the amount of a session is never left stale
// under an order that may have been paid.
//
// PUBLIC BY DESIGN, gated: the page must be open (real charging armed AND the
// settings switch) or the request must carry the current test-link token; flat
// 429 ceilings per network and per phone; a body no larger than the leases may
// add up to. Validation replaces the phone code: an Israeli mobile number, a
// valid email, and every row rule below. The page gate, the size, the ceiling
// of saves per network and the ceiling of file-carrying saves per network are
// all checked BEFORE the body is read — an anonymous caller cannot make the
// server buffer a large upload over and over.

/** Above this, a save carries a new lease file (the order itself is a few KB). */
const LARGE_BODY_BYTES = 512 * 1024;

const err = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, message, ...extra }, { status, headers: H });

const tokenBucket = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 24);

export async function POST(req: Request) {
  const settings = await getChipOrderSettings();
  const test = await isTestRequest(req);
  if (!chipOrdersOpen(settings) && !test) return err(403, 'ההזמנות ייפתחו בקרוב.');

  // Before the body is read at all: no larger than the leases may add up to.
  const length = Number(req.headers.get('content-length') ?? 'NaN');
  if (!Number.isFinite(length) || length > CHIP_ORDER_LIMITS.maxRequestBytes) {
    return err(413, 'הקבצים גדולים מדי. אפשר לצרף עד 40MB בהזמנה אחת.');
  }
  const ip = getClientIp(req);
  // Every save from one network (new orders and updates alike).
  const saveLimit = await checkRateLimit(`chip-order:save:ip:${ip}`, { max: 300, windowSec: 3600 });
  if (!saveLimit.allowed) return err(429, 'יותר מדי בקשות מהמכשיר הזה. נסו שוב מאוחר יותר.');
  // A body this large carries a NEW lease file (a save that keeps a lease
  // sends its key, a few KB) — and formData() buffers all of it. Such saves
  // have a ceiling of their own per network, counted before a byte is read.
  if (length > LARGE_BODY_BYTES) {
    const uploadLimit = await checkRateLimit(`chip-order:upload:ip:${ip}`, { max: 20, windowSec: 3600 });
    if (!uploadLimit.allowed) return err(429, 'יותר מדי קבצים נשלחו מהמכשיר הזה. נסו שוב מאוחר יותר.');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err(400, 'invalid_form_data');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get('order') ?? ''));
  } catch {
    return err(400, 'invalid_json');
  }
  const parsed = chipOrderSubmitSchema.safeParse(raw);
  if (!parsed.success) {
    return err(400, parsed.error.issues[0]?.message ?? 'invalid_body', { issues: parsed.error.issues });
  }
  const o = parsed.data;
  const updating = o.trackingToken !== undefined;

  const phoneE164 = toPortalE164(o.phone);
  if (!phoneE164 || !phoneE164.startsWith('+9725')) return err(400, 'נדרש מספר טלפון נייד ישראלי.');

  if (updating) {
    const orderLimit = await checkRateLimit(`chip-order:update:order:${tokenBucket(o.trackingToken!)}`, { max: 150, windowSec: 3600 });
    if (!orderLimit.allowed) return err(429, 'יותר מדי עדכונים להזמנה הזו. נסו שוב מאוחר יותר.');
  } else {
    const ipLimit = await checkRateLimit(`chip-order:submit:ip:${ip}`, { max: 10, windowSec: 3600 });
    if (!ipLimit.allowed) return err(429, 'יותר מדי הזמנות מהמכשיר הזה. נסו שוב מאוחר יותר.');
    const phoneLimit = await checkRateLimit(`chip-order:submit:phone:${phoneE164}`, { max: 5, windowSec: 3600 });
    if (!phoneLimit.allowed) return err(429, 'יותר מדי הזמנות למספר הזה. נסו שוב מאוחר יותר.');
  }

  // Row rules: a phone for every row, and a lease + its end date for every
  // renter row (a new file, or — on an update — the one the server holds).
  // One apartment orders at most maxChipsPerApartment chips over all its rows.
  const today = new Date().toISOString().slice(0, 10);
  const perApartment = new Map<string, number>();
  const rowPhones: string[] = [];
  for (const [i, r] of o.rows.entries()) {
    perApartment.set(r.apartment, (perApartment.get(r.apartment) ?? 0) + r.chipsCount);
    const rowPhone = toPortalE164(r.phone);
    if (!rowPhone) return err(400, `מספר טלפון לא תקין (שורה ${i + 1}).`);
    rowPhones.push(rowPhone);
    if (needsLease(r.role)) {
      if (!r.leaseEndDate) return err(400, `נדרש תאריך סיום חוזה (שורה ${i + 1}).`);
      if (r.leaseEndDate < today) return err(400, `תאריך סיום החוזה כבר עבר (שורה ${i + 1}).`);
      const file = form.get(`lease_${i}`);
      if (!(file instanceof File) && !(updating && r.leaseKey)) return err(400, `נדרש לצרף חוזה או הסכם ניהול (שורה ${i + 1}).`);
    }
  }
  for (const count of perApartment.values()) {
    if (count > CHIP_ORDER_LIMITS.maxChipsPerApartment) return err(400, CHIP_ORDER_APT_LIMIT_MESSAGE);
  }
  const hasRenter = o.rows.some((r) => needsLease(r.role));

  // Read + check every NEW lease before anything is stored.
  const leases: ({ bytes: Buffer; mime: string; name: string } | null)[] = [];
  for (let i = 0; i < o.rows.length; i++) {
    const file = form.get(`lease_${i}`);
    if (!needsLease(o.rows[i].role) || !(file instanceof File)) {
      leases.push(null);
      continue;
    }
    const read = await readLease(file);
    if (isLeaseError(read)) return err(400, `${read.error} (שורה ${i + 1}).`);
    leases.push(read);
  }
  const leaseBytes = leases.reduce((sum, l) => sum + (l?.bytes.byteLength ?? 0), 0);
  if (leaseBytes > CHIP_ORDER_LIMITS.maxLeaseBytesTotal) return err(413, 'הקבצים גדולים מדי. אפשר לצרף עד 40MB בהזמנה אחת.');

  const baseRows = o.rows.map((r, i) => ({
    role: r.role,
    fullName: r.fullName,
    apartmentNumber: r.apartment,
    chipsCount: r.chipsCount,
    phoneE164: rowPhones[i],
    email: r.email ? r.email : null,
    leaseEndDate: needsLease(r.role) ? (r.leaseEndDate ?? null) : null,
  }));

  // An update that changes the total of an order which already had a payment
  // session: rule out a charge on it first (see the header).
  if (updating) {
    const current = await getCardOrderByToken(o.trackingToken!);
    if (!current || current.source !== 'web' || current.is_test !== test) return err(409, 'ההזמנה כבר אינה ניתנת לעריכה.', { state: 'not_pending' });
    if (current.status !== 'pending_payment' || current.card_status === 'paid') {
      // Closed by the office (rejected / refunded) is not "paid": the page
      // starts a new order instead of waiting on a payment check.
      if (current.status === 'rejected') return err(409, 'ההזמנה נסגרה — אפשר לשלוח הזמנה חדשה.', { state: 'not_pending' });
      return err(409, 'ההזמנה כבר שולמה.', { state: 'paid' });
    }
    let newTotal: number;
    try {
      newTotal = chipOrderTotalOf({ rows: baseRows.map((r) => ({ ...r, lease: null })) }, settings);
    } catch {
      return err(400, 'אחת הדירות לא נמצאה.');
    }
    if (current.card_page_request_uid && agorot(newTotal) !== agorot(current.total)) {
      const cfg = lookupConfigFor(current.card_env ?? (test ? 'sandbox' : 'production'));
      let earlier: Awaited<ReturnType<typeof lookupCardPayment>> = { kind: 'unknown' };
      if (cfg) {
        try {
          earlier = await lookupCardPayment(cfg, current);
        } catch (e) {
          logger.warn('[chip-order] payplus lookup failed before an order update', { orderId: current.id, message: (e as Error).name });
        }
      }
      if (earlier.kind === 'paid') {
        if (earlier.transitioned) {
          const paidOrderId = earlier.orderId;
          after(() => afterOrderPaid(paidOrderId));
        }
        return err(409, 'ההזמנה כבר שולמה.', { state: 'paid' });
      }
      if (earlier.kind === 'unknown') {
        return err(502, 'לא ניתן לבדוק כרגע את ניסיון התשלום הקודם, ולכן הסכום לא עודכן. נסו שוב בעוד כמה דקות.');
      }
      // Nothing was charged: the session of the old amount is killed (the page
      // opens a new one for the new total).
      if (cfg) await disablePaymentRequest(cfg, current.card_page_request_uid);
    }
  }

  // Upload the new leases.
  const uploadedKeys: string[] = [];
  const stored: (NewOrderRow['lease'] | ReusedLease | null)[] = [];
  try {
    for (const [i, r] of o.rows.entries()) {
      const lease = leases[i];
      if (lease) {
        const up = await uploadChipOrderLease(lease.bytes, lease.name, lease.mime);
        uploadedKeys.push(up.objectKey);
        stored.push({ objectKey: up.objectKey, fileName: lease.name, mime: lease.mime, size: up.sizeBytes });
      } else if (updating && needsLease(r.role) && r.leaseKey) {
        stored.push({ reuseKey: r.leaseKey });
      } else {
        stored.push(null);
      }
    }
  } catch (e) {
    await removeChipOrderLeases(uploadedKeys).catch(() => {});
    logger.error('[chip-order] lease upload failed', e);
    return err(502, 'העלאת החוזה נכשלה. נסו שוב.');
  }

  // The order-level name and role are the first row's (the orderer is
  // whoever filled the form; the contact block carries no name). The old
  // `address` column is composed from the three parts.
  const address = `${o.addressStreet}, ${o.addressCity} ${o.addressZip}`;
  const common = {
    fullName: o.rows[0].fullName, phoneE164, email: o.email, address, role: o.rows[0].role,
    addressParts: { street: o.addressStreet, city: o.addressCity, zip: o.addressZip },
    renterTermsAccepted: hasRenter && o.acceptRenterTerms === true,
    note: o.note ? o.note : null,
    isTest: test,
  };
  let order: { orderNumber: number; total: number; trackingToken: string };
  let leaseKeys: (string | null)[];
  try {
    if (updating) {
      const updated = await updatePendingChipOrder(
        o.trackingToken!,
        { ...common, rows: baseRows.map((r, i) => ({ ...r, lease: stored[i] })) },
        settings,
      );
      order = updated;
      leaseKeys = updated.leaseKeys;
      if (updated.droppedLeaseKeys.length > 0) {
        const dropped = updated.droppedLeaseKeys;
        after(() => removeChipOrderLeases(dropped).catch((e) => logger.warn('[chip-order] dropped lease not removed', { count: dropped.length, message: (e as Error).name })));
      }
    } else {
      const created = await createChipOrder(
        { ...common, rows: baseRows.map((r, i) => ({ ...r, lease: stored[i] as NewOrderRow['lease'] })), ip },
        settings,
      );
      order = created;
      leaseKeys = stored.map((s) => (s && 'objectKey' in s ? s.objectKey : null));
    }
  } catch (e) {
    await removeChipOrderLeases(uploadedKeys).catch(() => {});
    if (e instanceof Error && e.message === 'apartment_not_found') return err(400, 'אחת הדירות לא נמצאה.');
    if (e instanceof ChipOrderStateError) {
      if (e.message === 'lease_not_found') return err(400, 'יש לצרף את החוזה מחדש.', { state: 'lease_missing' });
      return err(409, 'ההזמנה כבר אינה ניתנת לעריכה.', { state: 'not_pending' });
    }
    logger.error('[chip-order] save failed', e);
    return err(500, 'שמירת ההזמנה נכשלה. נסו שוב.');
  }

  return NextResponse.json(
    {
      ok: true,
      test,
      orderNumber: order.orderNumber,
      total: order.total,
      trackingToken: order.trackingToken,
      // The payment step is the card (the order's environment is configured).
      cardPayment: cardConfigFor(test) !== null,
      leaseKeys,
    },
    { status: updating ? 200 : 201, headers: H },
  );
}
