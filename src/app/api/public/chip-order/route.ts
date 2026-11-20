import { NextResponse } from 'next/server';
import { chipOrderSubmitSchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { toPortalE164, e164ToLocal } from '@/lib/portal/phone';
import { appUrl } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { createChipOrder, setOrderGrowProcess, type NewOrderRow } from '@/lib/db/chipOrders';
import { uploadChipOrderLease, removeChipOrderLeases } from '@/lib/storage/chipOrderLeaseStorage';
import { createPaymentProcess, GrowApiError } from '@/lib/grow/client';
import { isLeaseError, readLease } from '@/lib/chipOrders/lease';
import { CHIP_ORDER_LIMITS, needsLease } from '@/lib/chipOrders/model';
import {
  callbackSignature, chipOrdersOpen, readSkippedPhone, readVerifiedPhone, CHIP_ORDER_PUBLIC_HEADERS as H,
} from '@/lib/chipOrders/server';
import { isTestRequest } from '@/lib/chipOrders/testMode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order — the order form of /chip-order, multipart:
//   order     = JSON (chipOrderSubmitSchema — the contact block, the address in
//               three parts, and the ROWS: one person each — 20/11/2026)
//   lease_<i> = the lease of row i (renter rows only)
// Rows of the same apartment are priced together (the threshold counts per
// apartment over all its rows) and capped together at 6 chips per apartment.
//
// PUBLIC BY DESIGN, gated three ways: the page must be open (Grow configured
// AND the settings switch), the phone must have passed the OTP (the sealed
// cookie names the SAME phone as the form), and flat 429 ceilings per IP and
// per phone. Everything is validated here; the PRICE is computed here from the
// settings and never read from the browser. The order is created as
// pending_payment — invisible in /chips until Grow confirms the payment.
//
// Test mode (13/11/2026): with the CURRENT test-link token in the
// X-Chip-Order-Test header the page counts as open, everything above runs
// unchanged, the order is created is_test, and Grow is never called — the
// answer carries the tracking token for "סיים הזמנת בדיקה"
// (/api/public/chip-order/test-finish).
//
// "דלג על אימות (מצב בדיקה)" (13/11/2026): in test mode ONLY, the phone may
// carry the sealed SKIP cookie (/api/public/chip-order/otp/skip) instead of the
// verified one. It counts only while this same request carries the valid test
// token; the order is then stored phone_verified = false. Without the token a
// skip cookie is ignored — a real order still needs a verified code.

const err = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, message, ...extra }, { status, headers: H });

export async function POST(req: Request) {
  const settings = await getChipOrderSettings();
  const test = await isTestRequest(req);
  if (!chipOrdersOpen(settings) && !test) return err(403, 'ההזמנות ייפתחו בקרוב.');

  // Before the body is read at all: a verified phone (the sealed OTP cookie)
  // and a body no larger than the leases may add up to — an anonymous caller
  // cannot make the server buffer a large upload.
  const verified = await readVerifiedPhone();
  const skipped = !verified && test ? await readSkippedPhone() : null;
  const provenPhone = verified ?? skipped;
  if (!provenPhone) return err(401, 'יש לאמת את מספר הטלפון בקוד לפני התשלום.', { needsOtp: true });
  const length = Number(req.headers.get('content-length') ?? 'NaN');
  if (!Number.isFinite(length) || length > CHIP_ORDER_LIMITS.maxRequestBytes) {
    return err(413, 'הקבצים גדולים מדי. אפשר לצרף עד 40MB בהזמנה אחת.');
  }

  const ip = getClientIp(req);
  const ipLimit = await checkRateLimit(`chip-order:submit:ip:${ip}`, { max: 10, windowSec: 3600 });
  if (!ipLimit.allowed) return err(429, 'יותר מדי הזמנות מהמכשיר הזה. נסו שוב מאוחר יותר.');

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

  const phoneE164 = toPortalE164(o.phone);
  if (!phoneE164 || !phoneE164.startsWith('+9725')) return err(400, 'נדרש מספר טלפון נייד ישראלי.');
  if (provenPhone !== phoneE164) return err(401, 'יש לאמת את מספר הטלפון בקוד לפני התשלום.', { needsOtp: true });

  const phoneLimit = await checkRateLimit(`chip-order:submit:phone:${phoneE164}`, { max: 5, windowSec: 3600 });
  if (!phoneLimit.allowed) return err(429, 'יותר מדי הזמנות למספר הזה. נסו שוב מאוחר יותר.');

  // Row rules: at most 6 chips per apartment (all its rows together), at most
  // 10 apartments, a phone for every row, and a lease + its end date for every
  // renter row; with a renter row the renter commitment box is required.
  const today = new Date().toISOString().slice(0, 10);
  const perApartment = new Map<string, number>();
  const rowPhones: string[] = [];
  const max = CHIP_ORDER_LIMITS.maxChipsPerApartment;
  for (const [i, r] of o.rows.entries()) {
    perApartment.set(r.apartment, (perApartment.get(r.apartment) ?? 0) + r.chipsCount);
    const rowPhone = toPortalE164(r.phone);
    if (!rowPhone) return err(400, `מספר טלפון לא תקין (שורה ${i + 1}).`);
    rowPhones.push(rowPhone);
    if (needsLease(r.role)) {
      if (!r.leaseEndDate) return err(400, `נדרש תאריך סיום חוזה (שורה ${i + 1}).`);
      if (r.leaseEndDate < today) return err(400, `תאריך סיום החוזה כבר עבר (שורה ${i + 1}).`);
      if (!(form.get(`lease_${i}`) instanceof File)) return err(400, `נדרש לצרף חוזה או הסכם ניהול (שורה ${i + 1}).`);
    }
  }
  for (const [apt, count] of perApartment) {
    if (count > max) return err(400, `אפשר להזמין עד ${max} כרטיסים לדירה (דירה ${apt}).`);
  }
  if (perApartment.size > CHIP_ORDER_LIMITS.maxApartmentsPerOrder) {
    return err(400, `עד ${CHIP_ORDER_LIMITS.maxApartmentsPerOrder} דירות בהזמנה אחת.`);
  }
  const hasRenter = o.rows.some((r) => needsLease(r.role));
  if (hasRenter && o.acceptRenterTerms !== true) {
    return err(400, 'נדרש לאשר את התחייבות השוכר להחזרת הכרטיס.');
  }

  // Read + check every lease before anything is stored.
  const leases: ({ bytes: Buffer; mime: string; name: string } | null)[] = [];
  for (let i = 0; i < o.rows.length; i++) {
    if (!needsLease(o.rows[i].role)) {
      leases.push(null);
      continue;
    }
    const read = await readLease(form.get(`lease_${i}`) as File);
    if (isLeaseError(read)) return err(400, `${read.error} (שורה ${i + 1}).`);
    leases.push(read);
  }
  const leaseBytes = leases.reduce((sum, l) => sum + (l?.bytes.byteLength ?? 0), 0);
  if (leaseBytes > CHIP_ORDER_LIMITS.maxLeaseBytesTotal) return err(413, 'הקבצים גדולים מדי. אפשר לצרף עד 40MB בהזמנה אחת.');

  const uploadedKeys: string[] = [];
  let rows: NewOrderRow[];
  try {
    rows = [];
    for (const [i, r] of o.rows.entries()) {
      const lease = leases[i];
      let stored: NewOrderRow['lease'] = null;
      if (lease) {
        const up = await uploadChipOrderLease(lease.bytes, lease.name, lease.mime);
        uploadedKeys.push(up.objectKey);
        stored = { objectKey: up.objectKey, fileName: lease.name, mime: lease.mime, size: up.sizeBytes };
      }
      rows.push({
        role: r.role,
        fullName: r.fullName,
        apartmentNumber: r.apartment,
        chipsCount: r.chipsCount,
        phoneE164: rowPhones[i],
        email: r.email ? r.email : null,
        lease: stored,
        leaseEndDate: needsLease(r.role) ? (r.leaseEndDate ?? null) : null,
      });
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
  let order;
  try {
    order = await createChipOrder(
      {
        fullName: o.rows[0].fullName, phoneE164, email: o.email, address, role: o.rows[0].role, rows,
        addressParts: { street: o.addressStreet, city: o.addressCity, zip: o.addressZip },
        renterTermsAccepted: hasRenter && o.acceptRenterTerms === true,
        ip, isTest: test,
        phoneVerified: verified === phoneE164,
      },
      settings,
    );
  } catch (e) {
    await removeChipOrderLeases(uploadedKeys).catch(() => {});
    if (e instanceof Error && e.message === 'apartment_not_found') return err(400, 'אחת הדירות לא נמצאה.');
    logger.error('[chip-order] create failed', e);
    return err(500, 'שמירת ההזמנה נכשלה. נסו שוב.');
  }

  const base = appUrl();
  const track = `${base}/chip-order/track/${order.trackingToken}`;
  if (test) {
    return NextResponse.json(
      { ok: true, test: true, orderNumber: order.orderNumber, total: order.total, trackingToken: order.trackingToken, trackUrl: track },
      { status: 201, headers: H },
    );
  }
  try {
    const payment = await createPaymentProcess({
      sum: order.total,
      description: `הזמנה ${order.orderNumber} כרטיסי כניסה למעלית`,
      fullName: o.rows[0].fullName,
      phoneLocal: e164ToLocal(phoneE164),
      email: o.email,
      successUrl: `${track}?paid=1`,
      cancelUrl: `${track}?cancelled=1`,
      notifyUrl: `${base}/api/public/chip-order/grow/notify?o=${order.id}&s=${callbackSignature('notify', order.id)}`,
      invoiceNotifyUrl: `${base}/api/public/chip-order/grow/invoice?o=${order.id}&s=${callbackSignature('invoice', order.id)}`,
      orderId: order.id,
    });
    await setOrderGrowProcess(order.id, payment.processId, payment.processToken);
    return NextResponse.json(
      { ok: true, orderNumber: order.orderNumber, total: order.total, paymentUrl: payment.url, trackUrl: track },
      { status: 201, headers: H },
    );
  } catch (e) {
    const detail = e instanceof GrowApiError ? { code: e.code, message: e.message } : { message: (e as Error).message };
    logger.error('[chip-order] grow createPaymentProcess failed', { orderId: order.id, ...detail });
    return err(502, 'לא ניתן לפתוח את דף התשלום כרגע. נסו שוב בעוד כמה דקות.');
  }
}
