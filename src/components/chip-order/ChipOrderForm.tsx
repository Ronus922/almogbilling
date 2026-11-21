'use client';

// /chip-order — the public order form, redesigned 20/11/2026 after
// ref/chip-order/chip-purchase-page-v2.html (DESIGN.md declared exception).
//
//   · ההזמנה — one row per PERSON who will hold chips (role owner / renter,
//     full name, apartment, quantity, phone, email). Several rows may share an
//     apartment; "הוספת דירה" adds a row prefilled with the previous row's
//     name, phone and email. A renter row needs its lease + its end date.
//     One flat price per chip (21/11/2026): total = all chips × the price of
//     /settings — the server recomputes it. One apartment orders at most
//     CHIP_ORDER_LIMITS.maxChipsPerApartment chips over all its rows (21/11
//     noon): the plus button past it, or a submit past it, shows the message
//     next to the quantity instead; the server refuses it too.
//   · פרטי התקשרות — the orderer's phone (the code goes there), email, the
//     current address (street + number, city, 7-digit zip) and an optional
//     "הערות" (≤ 500), stored as the order's note — the issue window's "הערה".
//   · אישור ותשלום — card fields drawn as in the reference but UI ONLY: no
//     `name`, never read, never sent, never stored. The processor's hosted
//     fields will replace them. With Grow configured (the page open to the
//     public) the existing Grow iframe step follows the phone code, unchanged.
//   · the agreement card — "the details are correct", plus the renter
//     commitment when a renter row exists, and the pay button.
// The phone code step (SMS, WhatsApp fallback, test-mode skip) sits where it
// always did: after the pay button, before the payment. In test mode (a valid
// test link) the pay button ends with "סיים הזמנת בדיקה" on the server — no
// Grow, no charge — and the confirmation screen.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toPortalE164 } from '@/lib/portal/phone';
import {
  CHIP_ORDER_APT_LIMIT_MESSAGE, CHIP_ORDER_LIMITS, CHIP_ORDER_TEST_HEADER, LEASE_FILE_ACCEPT, formatIlsAfter, priceLine,
} from '@/lib/chipOrders/model';
import { leaseFileProblem } from '@/lib/chipOrders/lease';
import { ApartmentCombo } from './ApartmentCombo';
import { ChipOrderConfirmation, type ConfirmedRow } from './ChipOrderConfirmation';

interface Pricing {
  unitPrice: number;
}

type Role = 'owner' | 'tenant';

interface Row {
  key: number;
  role: Role;
  name: string;
  apt: string;
  qty: number;
  phone: string;
  email: string;
  file: File | null;
  end: string;
}

type Step = 'form' | 'otp' | 'paying' | 'done';

// Grow's payment iframe posts from one of these (R/postmessage).
const GROW_ORIGINS = ['https://meshulam.co.il', 'https://secure.meshulam.co.il', 'https://sandbox.meshulam.co.il'];
const PAID_ACTIONS = ['payment', 'bit_payment', 'apple_payment', 'google_payment'];
const APT_MAX = CHIP_ORDER_LIMITS.maxChipsPerApartment;
const NOTE_MAX = CHIP_ORDER_LIMITS.customerNoteMax;

function todayIso(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function newRow(key: number, from?: Row): Row {
  return {
    key, role: 'owner', name: from?.name ?? '', apt: '', qty: 1,
    phone: from?.phone ?? '', email: from?.email ?? '', file: null, end: '',
  };
}

/** Rows without an apartment yet count as their own group. */
const groupKey = (r: Row) => (r.apt ? `a:${r.apt}` : `r:${r.key}`);

const isEmail = (v: string) => z.email().safeParse(v.trim().toLowerCase()).success;

// ── Icons of the reference (inline, as drawn there) ─────────────────────────
function Svg({ size = 17, sw = 1.9, children }: { size?: number; sw?: number; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const BuildingIcon = () => <Svg><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M9 17h1m4 0h1" /></Svg>;
const PhoneIcon = () => (
  <Svg><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z" /></Svg>
);
const ShieldIcon = () => <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></Svg>;
const LockIcon = ({ size = 17, sw = 2 }: { size?: number; sw?: number }) => (
  <Svg size={size} sw={sw}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>
);
const TrashIcon = () => (
  <Svg size={15}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></Svg>
);
const UploadIcon = () => <Svg size={15}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></Svg>;
const PlusIcon = () => <Svg size={15} sw={2.4}><path d="M12 5v14M5 12h14" /></Svg>;
const CardIcon = () => <Svg><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></Svg>;

function Err({ msg }: { msg?: string }) {
  return msg ? <span className="cr-err">{msg}</span> : null;
}

export function ChipOrderForm({
  apartments, pricing, termsText, testToken = null,
}: {
  apartments: string[];
  pricing: Pricing;
  termsText: string;
  /** Test mode: the token of the test link (the server checked it). */
  testToken?: string | null;
}) {
  const router = useRouter();
  const testHeaders: Record<string, string> = testToken ? { [CHIP_ORDER_TEST_HEADER]: testToken } : {};
  const seq = useRef(1);
  const [step, setStep] = useState<Step>('form');
  const [rows, setRows] = useState<Row[]>([newRow(0)]);
  const [openCombo, setOpenCombo] = useState<number | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [zip, setZip] = useState('');
  const [note, setNote] = useState('');
  const [agree, setAgree] = useState(false);
  const [agreeRent, setAgreeRent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Phone code
  const [code, setCode] = useState('');
  const [otpInfo, setOtpInfo] = useState<string | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [otpChannel, setOtpChannel] = useState<'sms' | 'whatsapp' | null>(null);
  const [offerWhatsApp, setOfferWhatsApp] = useState(false);
  const [codeAsked, setCodeAsked] = useState(false);

  // Payment / result
  const [payment, setPayment] = useState<{ url: string; trackUrl: string; orderNumber: number; total: number } | null>(null);
  const [testOrder, setTestOrder] = useState<{ trackingToken: string; orderNumber: number; total: number } | null>(null);
  const [done, setDone] = useState<{ orderNumber: number; total: number; rows: ConfirmedRow[] } | null>(null);
  const [payNote, setPayNote] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Grow's postMessage: a completed payment goes to the tracking page.
  useEffect(() => {
    if (step !== 'paying' || !payment) return;
    function onMessage(ev: MessageEvent) {
      if (!GROW_ORIGINS.includes(ev.origin)) return;
      const data = (ev.data ?? {}) as { action?: string; status?: number | string };
      if (data.action && PAID_ACTIONS.includes(data.action) && (data.action !== 'payment' || Number(data.status) === 1)) {
        router.push(`${new URL(payment!.trackUrl).pathname}?paid=1`);
      } else if (data.action === 'close') {
        setPayNote('חלון התשלום נסגר. אפשר לחזור אליו כל עוד לא עברו 10 דקות.');
      } else if (data.action === 'failed_to_load_page') {
        setPayNote('דף התשלום לא נטען. רעננו את הדף ונסו שוב.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [step, payment, router]);

  // Chips per apartment (all its rows) — for the per-apartment maximum.
  const perGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(groupKey(r), (m.get(groupKey(r)) ?? 0) + r.qty);
    return m;
  }, [rows]);
  // One flat price: every chip of the order × the unit price.
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const total = priceLine(totalQty, pricing).lineTotal;
  const hasRenter = rows.some((r) => r.role === 'tenant');
  const locked = step === 'otp' || busy;

  function patchRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /** Clears the quantity message of every row of r's apartment. */
  function clearQtyErrors(r: Row) {
    const keys = rows.filter((x) => groupKey(x) === groupKey(r)).map((x) => `qty_${x.key}`);
    setErrors((prev) => {
      if (!keys.some((k) => prev[k])) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  function addChip(r: Row) {
    if ((perGroup.get(groupKey(r)) ?? 0) + 1 > APT_MAX) {
      setErrors((prev) => ({ ...prev, [`qty_${r.key}`]: CHIP_ORDER_APT_LIMIT_MESSAGE }));
      return;
    }
    clearQtyErrors(r);
    patchRow(r.key, { qty: r.qty + 1 });
  }

  function removeChip(r: Row) {
    clearQtyErrors(r);
    patchRow(r.key, { qty: r.qty - 1 });
  }

  function addRow() {
    const key = seq.current++;
    setRows((prev) => [...prev, newRow(key, prev[prev.length - 1])]);
    setOpenCombo(key);
  }

  function setRole(key: number, role: Role) {
    patchRow(key, { role });
    if (role === 'owner' && !rows.some((r) => r.key !== key && r.role === 'tenant')) setAgreeRent(false);
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    const today = todayIso();
    for (const r of rows) {
      if (r.name.trim().split(/\s+/).filter(Boolean).length < 2) e[`name_${r.key}`] = 'נדרש שם מלא — שם פרטי ושם משפחה';
      if (!r.apt) e[`apt_${r.key}`] = 'נדרש לבחור דירה';
      if ((perGroup.get(groupKey(r)) ?? 0) > APT_MAX) e[`qty_${r.key}`] = CHIP_ORDER_APT_LIMIT_MESSAGE;
      if (!toPortalE164(r.phone)) e[`phone_${r.key}`] = 'נדרש מספר טלפון נייד';
      if (r.email.trim() && !isEmail(r.email)) e[`email_${r.key}`] = 'כתובת מייל לא תקינה';
      if (r.role === 'tenant') {
        if (!r.file) e[`file_${r.key}`] = 'נדרש לצרף חוזה או הסכם ניהול';
        else {
          const p = leaseFileProblem(r.file);
          if (p) e[`file_${r.key}`] = p;
        }
        if (!r.end) e[`end_${r.key}`] = 'נדרש תאריך סיום חוזה';
        else if (r.end < today) e[`end_${r.key}`] = 'תאריך סיום החוזה כבר עבר';
      }
    }
    const leaseBytes = rows.reduce((s, r) => s + (r.role === 'tenant' ? r.file?.size ?? 0 : 0), 0);
    const lastRenter = [...rows].reverse().find((r) => r.role === 'tenant');
    if (leaseBytes > CHIP_ORDER_LIMITS.maxLeaseBytesTotal && lastRenter) e[`file_${lastRenter.key}`] = 'כל הקבצים יחד עד 40MB בהזמנה אחת';
    const e164 = toPortalE164(phone);
    if (!e164 || !e164.startsWith('+9725')) e.phone = 'נדרש מספר טלפון נייד ישראלי';
    if (!isEmail(email)) e.email = 'כתובת מייל לא תקינה';
    if (street.trim().length < 2) e.street = 'נדרשת כתובת מגורים';
    if (city.trim().length < 2) e.city = 'נדרשת עיר';
    if (!/^\d{7}$/.test(zip.trim())) e.zip = 'מיקוד — 7 ספרות';
    if (!agree) e.agree = 'נדרש לאשר שהפרטים נכונים';
    if (hasRenter && !agreeRent) e.agreeRent = 'נדרש לאשר את התחייבות השוכר';
    setErrors(e);
    if (Object.keys(e).length > 0) {
      requestAnimationFrame(() => {
        document.querySelector('.cr-skin .cr-bad')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      return false;
    }
    return true;
  }

  async function requestCode(channel?: 'whatsapp') {
    setBusy(true);
    setServerError(null);
    setCodeAsked(true);
    try {
      const res = await fetch('/api/public/chip-order/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...testHeaders },
        body: JSON.stringify({ phone, ...(channel ? { channel } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; channel?: string; retryAfterSec?: number };
      if (!res.ok || !data.ok) {
        if (data.retryAfterSec) setCooldown(data.retryAfterSec);
        // A send that failed outright (not a ceiling) may still go out on
        // WhatsApp once the resend cooldown it started is over; a request
        // refused only by that cooldown keeps the button (13/11/2026).
        const cooldownOnly = res.status === 429 && Boolean(data.retryAfterSec);
        setOfferWhatsApp((prev) =>
          res.status === 502 ? channel !== 'whatsapp' : cooldownOnly && (prev || channel === 'whatsapp'),
        );
        throw new Error(data.message ?? 'שליחת הקוד נכשלה');
      }
      setOfferWhatsApp(false);
      setOtpChannel(data.channel === 'sms' ? 'sms' : 'whatsapp');
      setOtpInfo(data.channel === 'sms' ? 'שלחנו קוד בן 6 ספרות ב-SMS.' : 'שלחנו קוד בן 6 ספרות בוואטסאפ.');
      setCooldown(45);
      setCode('');
      setStep('otp');
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function confirmedRows(): ConfirmedRow[] {
    return rows.map((r) => ({ apartment: r.apt, name: r.name.trim(), role: r.role, qty: r.qty }));
  }

  /** "סיים הזמנת בדיקה" on the server (test order only) → the confirmation. */
  async function finishTestOrder(t: { trackingToken: string; orderNumber: number; total: number }): Promise<void> {
    const res = await fetch('/api/public/chip-order/test-finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...testHeaders },
      body: JSON.stringify({ trackingToken: t.trackingToken }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok || !data.ok) throw new Error(data.message ?? 'סיום הזמנת הבדיקה נכשל');
    setTestOrder(null);
    setDone({ orderNumber: t.orderNumber, total: t.total, rows: confirmedRows() });
    setStep('done');
  }

  async function submitOrder(): Promise<void> {
    const fd = new FormData();
    fd.append(
      'order',
      JSON.stringify({
        phone,
        email: email.trim(),
        addressStreet: street.trim(),
        addressCity: city.trim(),
        addressZip: zip.trim(),
        note: note.trim(),
        acceptTerms: agree,
        acceptRenterTerms: hasRenter ? agreeRent : false,
        rows: rows.map((r) => ({
          role: r.role,
          fullName: r.name.trim(),
          apartment: r.apt,
          chipsCount: r.qty,
          phone: r.phone,
          email: r.email.trim(),
          leaseEndDate: r.role === 'tenant' ? r.end || null : null,
        })),
      }),
    );
    rows.forEach((r, i) => { if (r.role === 'tenant' && r.file) fd.append(`lease_${i}`, r.file); });
    const res = await fetch('/api/public/chip-order', { method: 'POST', body: fd, headers: testHeaders });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean; message?: string; needsOtp?: boolean; test?: boolean; trackingToken?: string;
      paymentUrl?: string; trackUrl?: string; orderNumber?: number; total?: number;
    };
    if (res.status === 401 && data.needsOtp) {
      setVerifiedPhone(null);
      await requestCode();
      return;
    }
    if (res.ok && data.ok && data.test && data.trackingToken) {
      const t = { trackingToken: data.trackingToken, orderNumber: data.orderNumber ?? 0, total: data.total ?? total };
      setTestOrder(t);
      await finishTestOrder(t);
      return;
    }
    if (!res.ok || !data.ok || !data.paymentUrl || !data.trackUrl) throw new Error(data.message ?? 'שליחת ההזמנה נכשלה');
    setPayment({ url: data.paymentUrl, trackUrl: data.trackUrl, orderNumber: data.orderNumber ?? 0, total: data.total ?? total });
    setStep('paying');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function onPay() {
    setServerError(null);
    // A test order already created whose finish failed: only finish it again.
    if (testOrder) {
      setBusy(true);
      try { await finishTestOrder(testOrder); } catch (err) { setServerError((err as Error).message); } finally { setBusy(false); }
      return;
    }
    if (!validate()) return;
    const e164 = toPortalE164(phone);
    if (verifiedPhone && verifiedPhone === e164) {
      setBusy(true);
      try { await submitOrder(); } catch (err) { setServerError((err as Error).message); } finally { setBusy(false); }
      return;
    }
    await requestCode();
  }

  async function onVerify() {
    if (!/^\d{6}$/.test(code)) {
      setServerError('הקוד חייב להכיל 6 ספרות');
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const res = await fetch('/api/public/chip-order/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...testHeaders },
        body: JSON.stringify({ phone, code }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) throw new Error(data.message ?? 'האימות נכשל');
      setVerifiedPhone(toPortalE164(phone));
      await submitOrder();
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // "דלג על אימות (מצב בדיקה)" — test link only; the server checks the token
  // again on the submit, and the order is stored "טלפון לא אומת".
  async function skipVerification() {
    setServerError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/public/chip-order/otp/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...testHeaders },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) throw new Error(data.message ?? 'הדילוג על האימות נכשל');
      setOfferWhatsApp(false);
      setVerifiedPhone(toPortalE164(phone));
      await submitOrder();
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Confirmation ─────────────────────────────────────────────────────────
  if (step === 'done' && done) {
    return (
      <>
        <ChipOrderConfirmation orderNumber={done.orderNumber} rows={done.rows} total={done.total} />
        <p className="cr-foot">הקבלה תישלח למייל לאחר התשלום</p>
      </>
    );
  }

  // ── Grow's payment page (the page open to the public, Grow configured) ────
  if (step === 'paying' && payment) {
    return (
      <section className="cr-card">
        <div className="cr-chead">
          <span className="cr-cic cr-green"><ShieldIcon /></span>
          <div>
            <b>תשלום — הזמנה <span className="cr-num">{payment.orderNumber}</span></b>
            <small>סה&quot;כ לתשלום <span className="cr-num">{formatIlsAfter(payment.total)}</span></small>
          </div>
        </div>
        <div className="cr-cbody flex flex-col gap-3">
          <iframe src={payment.url} title="תשלום מאובטח" allow="payment" className="cr-payframe" data-testid="chip-order-payment" />
          {payNote && <p role="status" className="cr-note">{payNote}</p>}
          <p className="cr-secure">
            <LockIcon size={14} sw={2.2} />
            התשלום מתבצע בדף המאובטח של Grow. החשבונית / הקבלה תופק ותישלח אליך מ-Grow.
          </p>
        </div>
      </section>
    );
  }

  // ── The form ─────────────────────────────────────────────────────────────
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => { e.preventDefault(); void (step === 'otp' ? onVerify() : onPay()); }}
    >
      <section className="cr-intro">
        <p>דיירים יקרים,</p>
        <p>דייר המעוניין להזמין כרטיסי בקרת כניסה לבניין ולשימוש במעליות מוזמן למלא את פרטיו האישיים בטופס ההזמנה ולהסדיר את התשלום. לאחר קבלת ההזמנה והתשלום, נדאג להכנת הכרטיסים ונשלח אליכם הודעה ברגע שיהיו מוכנים.</p>
        <p><b>לנוחיותכם, ניתן יהיה לאסוף את הכרטיסים מהשומר בלובי הבניין בכל יום ובכל שעה, ללא צורך בתיאום מראש.</b></p>
        <p className="cr-sig">תודה על שיתוף הפעולה,<br />הנהלת הבניין</p>
      </section>

      {/* ההזמנה — one row per person */}
      <section className="cr-card">
        <div className="cr-chead"><span className="cr-cic"><BuildingIcon /></span><div><b>ההזמנה</b></div></div>
        <div className="cr-cbody">
          <div>
            {rows.map((r, i) => {
              return (
                <div key={r.key} className="cr-orow" data-testid="chip-order-line">
                  {rows.length > 1 && (
                    <button type="button" className="cr-delapt" title="הסרה" aria-label={`הסרת שורה ${i + 1}`} disabled={locked}
                      onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                      <TrashIcon />
                    </button>
                  )}
                  <div className="cr-fld cr-segfld">
                    <span className="cr-lbl">אני</span>
                    <div className="cr-seg" role="radiogroup" aria-label={`אני, שורה ${i + 1}`}>
                      {(['owner', 'tenant'] as const).map((role) => (
                        <button key={role} type="button" role="radio" aria-checked={r.role === role} disabled={locked}
                          className={cn(r.role === role && 'cr-on')} onClick={() => setRole(r.key, role)}>
                          {role === 'owner' ? 'בעלים' : 'שוכר'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="cr-mainrow">
                    <div className="cr-fld">
                      <label htmlFor={`co-name-${r.key}`}>שם מלא <span className="cr-req">*</span></label>
                      <input id={`co-name-${r.key}`} type="text" value={r.name} placeholder="שם המזמין" autoComplete="name" disabled={locked}
                        className={cn(errors[`name_${r.key}`] && 'cr-bad')} onChange={(e) => patchRow(r.key, { name: e.target.value })} />
                      <Err msg={errors[`name_${r.key}`]} />
                    </div>
                    <div className="cr-fld">
                      <span className="cr-lbl">דירה <span className="cr-req">*</span></span>
                      <ApartmentCombo
                        apartments={apartments}
                        value={r.apt}
                        onChange={(apt) => patchRow(r.key, { apt })}
                        open={openCombo === r.key}
                        onOpenChange={(o) => setOpenCombo(o ? r.key : null)}
                        disabled={locked}
                        invalid={Boolean(errors[`apt_${r.key}`])}
                        label={`דירה, שורה ${i + 1}`}
                      />
                      <Err msg={errors[`apt_${r.key}`]} />
                    </div>
                    <div className="cr-fld">
                      <span className="cr-lbl">כמות כרטיסים</span>
                      <div className={cn('cr-qty', errors[`qty_${r.key}`] && 'cr-bad')}>
                        <button type="button" aria-label="פחות" disabled={locked || r.qty <= 1} onClick={() => removeChip(r)}>−</button>
                        <b className="cr-num" aria-live="polite">{r.qty}</b>
                        <button type="button" aria-label="יותר" disabled={locked} onClick={() => addChip(r)}>+</button>
                      </div>
                      <Err msg={errors[`qty_${r.key}`]} />
                    </div>
                  </div>
                  <div className="cr-perow">
                    <div className="cr-fld">
                      <label htmlFor={`co-phone-${r.key}`}>טלפון נייד <span className="cr-req">*</span></label>
                      <input id={`co-phone-${r.key}`} type="tel" inputMode="tel" autoComplete="tel" value={r.phone} disabled={locked}
                        className={cn('cr-num cr-ltr', errors[`phone_${r.key}`] && 'cr-bad')} onChange={(e) => patchRow(r.key, { phone: e.target.value })} />
                      <Err msg={errors[`phone_${r.key}`]} />
                    </div>
                    <div className="cr-fld">
                      <label htmlFor={`co-email-${r.key}`}>מייל</label>
                      <input id={`co-email-${r.key}`} type="email" inputMode="email" autoComplete="email" value={r.email} disabled={locked}
                        className={cn('cr-num cr-ltr', errors[`email_${r.key}`] && 'cr-bad')} onChange={(e) => patchRow(r.key, { email: e.target.value })} />
                      <Err msg={errors[`email_${r.key}`]} />
                    </div>
                  </div>
                  {r.role === 'tenant' && (
                    <div className="cr-rentrow">
                      <div className="cr-fld">
                        <span className="cr-lbl">חוזה / הסכם ניהול (PDF או תמונה)</span>
                        <label className={cn('cr-upl', r.file && 'cr-has', errors[`file_${r.key}`] && 'cr-bad')}>
                          <UploadIcon />
                          <span>{r.file ? r.file.name : 'בחירת קובץ'}</span>
                          <input type="file" accept={LEASE_FILE_ACCEPT} disabled={locked} aria-label={`חוזה, שורה ${i + 1}`}
                            onChange={(e) => patchRow(r.key, { file: e.target.files?.[0] ?? null })} />
                        </label>
                        <Err msg={errors[`file_${r.key}`]} />
                      </div>
                      <div className="cr-fld">
                        <label htmlFor={`co-end-${r.key}`}>תאריך סיום החוזה</label>
                        <input id={`co-end-${r.key}`} type="date" min={todayIso()} value={r.end} disabled={locked}
                          className={cn('cr-num', errors[`end_${r.key}`] && 'cr-bad')} onChange={(e) => patchRow(r.key, { end: e.target.value })} />
                        <Err msg={errors[`end_${r.key}`]} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {rows.length < CHIP_ORDER_LIMITS.maxRowsPerOrder && (
            <button className="cr-addapt" type="button" disabled={locked} onClick={addRow}>
              <PlusIcon />
              הוספת דירה
            </button>
          )}
          {errors.rows && <p className="cr-err mt-2">{errors.rows}</p>}
          {totalQty > 0 && (
            <div className="cr-brk" data-testid="chip-order-breakdown">
              <div className="cr-bh"><span>פריט</span><span className="cr-c">כמות</span><span className="cr-c">מחיר ליחידה</span><span className="cr-t">סה&quot;כ</span></div>
              <div className="cr-br">
                <span>כרטיס בקרת כניסה</span>
                <span className="cr-c cr-num">{totalQty}</span>
                <span className="cr-c cr-num">{formatIlsAfter(pricing.unitPrice)}</span>
                <span className="cr-t cr-num">{formatIlsAfter(total)}</span>
              </div>
            </div>
          )}
          <div className="cr-total">
            <span>סה&quot;כ לתשלום</span>
            <b className="cr-num" data-testid="chip-order-total">{formatIlsAfter(total)}</b>
          </div>
        </div>
      </section>

      {/* פרטי התקשרות — the orderer */}
      <section className="cr-card">
        <div className="cr-chead">
          <span className="cr-cic"><PhoneIcon /></span>
          <div><b>פרטי התקשרות</b><small>לעדכון כשהצ&apos;יפים מוכנים ולשליחת הקבלה</small></div>
        </div>
        <div className="cr-cbody">
          <div className="cr-contact">
            <div className="cr-fld">
              <label htmlFor="co-phone">טלפון נייד <span className="cr-req">*</span></label>
              <input id="co-phone" type="tel" inputMode="tel" autoComplete="tel" required value={phone} disabled={locked}
                className={cn('cr-num cr-ltr', errors.phone && 'cr-bad')} onChange={(e) => setPhone(e.target.value)} />
              <Err msg={errors.phone} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-email">מייל <span className="cr-req">*</span></label>
              <input id="co-email" type="email" inputMode="email" autoComplete="email" required value={email} disabled={locked}
                className={cn('cr-num cr-ltr', errors.email && 'cr-bad')} onChange={(e) => setEmail(e.target.value)} />
              <Err msg={errors.email} />
            </div>
          </div>
          <div className="cr-addrrow">
            <div className="cr-fld">
              <label htmlFor="co-street">כתובת מגורים נוכחית (רחוב ומספר בית) <span className="cr-req">*</span></label>
              <input id="co-street" type="text" required placeholder="לדוגמה: דוד אלעזר 10" autoComplete="street-address" value={street} disabled={locked}
                className={cn(errors.street && 'cr-bad')} onChange={(e) => setStreet(e.target.value)} />
              <Err msg={errors.street} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-city">עיר <span className="cr-req">*</span></label>
              <input id="co-city" type="text" required placeholder="חיפה" autoComplete="address-level2" value={city} disabled={locked}
                className={cn(errors.city && 'cr-bad')} onChange={(e) => setCity(e.target.value)} />
              <Err msg={errors.city} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-zip">מיקוד <span className="cr-req">*</span></label>
              <input id="co-zip" type="text" required inputMode="numeric" maxLength={7} placeholder="7 ספרות" autoComplete="postal-code" value={zip} disabled={locked}
                className={cn('cr-num cr-ltr', errors.zip && 'cr-bad')} onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 7))} />
              <Err msg={errors.zip} />
            </div>
          </div>
          <div className="cr-fld cr-notefld">
            <label htmlFor="co-note">הערות</label>
            <textarea id="co-note" rows={3} maxLength={NOTE_MAX} placeholder="למשל: אני מבקש למסור את הכרטיסים ל..." value={note} disabled={locked}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))} />
          </div>
        </div>
      </section>

      {/* אישור ותשלום — UI ONLY: no name, never read, never sent. */}
      <section className="cr-card" data-testid="chip-order-card-fields">
        <div className="cr-chead">
          <span className="cr-cic cr-green"><ShieldIcon /></span>
          <div><b>אישור ותשלום</b><small>תשלום מאובטח בכרטיס אשראי</small></div>
        </div>
        <div className="cr-cbody cr-cbody-tight">
          <div className="cr-frow">
            <div className="cr-fld cr-cardfld">
              <label htmlFor="co-ccnum">מספר כרטיס <span className="cr-req">*</span></label>
              <CardIcon />
              <input id="co-ccnum" type="text" inputMode="numeric" autoComplete="off" placeholder="0000 0000 0000 0000" maxLength={19}
                className="cr-num cr-ltr" disabled={locked}
                onInput={(e) => {
                  const t = e.currentTarget;
                  t.value = t.value.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
                }} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-ccid">ת&quot;ז בעל הכרטיס <span className="cr-req">*</span></label>
              <input id="co-ccid" type="text" inputMode="numeric" autoComplete="off" placeholder="9 ספרות" maxLength={9} className="cr-num cr-ltr" disabled={locked} />
            </div>
          </div>
          <div className="cr-paygrid">
            <div className="cr-fld">
              <label htmlFor="co-ccname">שם בעל הכרטיס <span className="cr-req">*</span></label>
              <input id="co-ccname" type="text" autoComplete="off" placeholder="כפי שמופיע על הכרטיס" disabled={locked} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-ccexp">תוקף <span className="cr-req">*</span></label>
              <input id="co-ccexp" type="text" inputMode="numeric" autoComplete="off" placeholder="MM/YY" maxLength={5} className="cr-num cr-ltr" disabled={locked}
                onInput={(e) => {
                  const t = e.currentTarget;
                  let v = t.value.replace(/\D/g, '').slice(0, 4);
                  if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`;
                  t.value = v;
                }} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-cccvv">CVV <span className="cr-req">*</span></label>
              <input id="co-cccvv" type="password" inputMode="numeric" autoComplete="off" placeholder="•••" maxLength={4} className="cr-num cr-ltr" disabled={locked} />
            </div>
          </div>
          <div className="cr-secure">
            <LockIcon size={14} sw={2.2} />
            הפרטים מוצפנים ומאובטחים — העסקה מבוצעת בתקן PCI-DSS
          </div>
        </div>
      </section>

      {/* Agreement + the phone code + pay */}
      <section className="cr-card">
        <div className="cr-cbody">
          {termsText.trim() && (
            <details className="cr-terms">
              <summary>תנאי ההזמנה</summary>
              <p>{termsText}</p>
            </details>
          )}
          <label className="cr-agree">
            <input type="checkbox" checked={agree} disabled={locked} onChange={(e) => setAgree(e.target.checked)} />
            <span>אני מאשר שהפרטים שמסרתי הינם נכונים.</span>
          </label>
          {hasRenter && (
            <label className="cr-agree">
              <input type="checkbox" checked={agreeRent} disabled={locked} onChange={(e) => setAgreeRent(e.target.checked)} />
              <span>השוכר מתחייב להחזיר את הכרטיס ולא לעשות בו שימוש לאחר סיום תקופת השכירות.</span>
            </label>
          )}

          {step === 'otp' && (
            <div className="cr-otp">
              <p>{otpInfo ?? 'שלחנו קוד אימות לטלפון.'}</p>
              <input
                className="cr-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                aria-label="קוד אימות"
                placeholder="______"
                autoFocus
              />
              <div className="cr-links">
                <button type="button" className="cr-link" disabled={busy || cooldown > 0} onClick={() => void requestCode()}>
                  {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown} שניות` : 'שליחת קוד חדש'}
                </button>
                {otpChannel === 'sms' && (
                  <button type="button" className="cr-link" disabled={busy || cooldown > 0} onClick={() => void requestCode('whatsapp')}>
                    שליחה בוואטסאפ במקום
                  </button>
                )}
                <button type="button" className="cr-link cr-muted" disabled={busy} onClick={() => { setStep('form'); setCode(''); }}>
                  חזרה לעריכת הפרטים
                </button>
              </div>
            </div>
          )}

          {serverError && (
            <div role="alert" className="cr-alert">
              {serverError}
              {offerWhatsApp && (
                <button type="button" className="cr-link" disabled={busy || cooldown > 0} onClick={() => void requestCode('whatsapp')}
                  data-testid="chip-order-otp-whatsapp-fallback">
                  {cooldown > 0 ? `שליחת הקוד בוואטסאפ במקום — בעוד ${cooldown} שניות` : 'שליחת הקוד בוואטסאפ במקום'}
                </button>
              )}
            </div>
          )}

          {testToken && (step === 'otp' || codeAsked) && !testOrder && (
            <div className="cr-skip">
              <p>מצב בדיקה: אפשר להמשיך בלי קוד. ההזמנה תסומן „טלפון לא אומת”.</p>
              <button type="button" disabled={busy} onClick={() => void skipVerification()} data-testid="chip-order-skip-verification">
                דלג על אימות (מצב בדיקה)
              </button>
            </div>
          )}

          <button type="submit" className="cr-submit" disabled={busy || !agree || (hasRenter && !agreeRent)} data-testid="chip-order-pay">
            {busy ? <Loader2 className="h-[17px] w-[17px] cr-spin" /> : <LockIcon />}
            {step === 'otp'
              ? <span>אימות והמשך לתשלום</span>
              : <span>תשלום מאובטח — <b className="cr-num">{formatIlsAfter(total)}</b></span>}
          </button>
          {(errors.agree || errors.agreeRent) && <p className="cr-err mt-2">{errors.agree ?? errors.agreeRent}</p>}
        </div>
      </section>
      <p className="cr-foot">הקבלה תישלח למייל לאחר התשלום</p>
    </form>
  );
}
