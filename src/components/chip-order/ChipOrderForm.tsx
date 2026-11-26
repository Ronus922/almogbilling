'use client';

// /chip-order — the public order form, redesigned 20/11/2026 after
// ref/chip-order/chip-purchase-page-v2.html (DESIGN.md declared exception).
// ONE FORM since 26/11/2026 (Ronen): every part is on the screen from the
// start, there is no phone code, and one button pays.
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
//   · פרטי התקשרות — the orderer's phone, email, the current address (street
//     + number, city, 7-digit zip) and an optional "הערות" (≤ 500), stored as
//     the order's note — the issue window's "הערה".
//   · אישור ותשלום — the wallet buttons (Google Pay / Apple Pay, each only
//     where the device and the account offer it) above PayPlus's hosted card
//     fields (PayPlusCardFields).
//   · the agreement card — "the details are correct", plus the renter
//     commitment when a renter row exists, and the one pay button.
//
// Card payment (`cardPayment`). A payment session can only be opened for an
// order that exists, at the amount the server computed for it. So the order
// is SAVED by itself (awaiting payment) shortly after the last change, once
// the details are complete and valid — the agreement boxes gate the payment,
// not the save — and saved again (the same order, by its tracking token)
// whenever they change. After a save the card fields open for it; when the
// saved total moves, they are opened again for the new amount (the
// processor's frames start empty, and the page says so). Until the first
// save the card boxes are drawn but cannot be typed into. The total and the
// pay button show what will be charged: the server prices every save, at the
// price per chip of /settings NOW — once saved, its price is the one shown,
// and when it is not the page's, the new amount is said before any charge.
// The pay button checks everything (and scrolls to the first problem), saves
// what was not saved yet, and charges through the hosted fields — unless that
// save changed the amount, or the fields were not open yet: then they open,
// and the button stops there. The wallet buttons are live only when the pay
// button would charge at once (complete, saved, agreed, nothing in flight);
// a tap on them before that shows what is missing.
// A refused charge shows a Hebrew line and leaves everything as typed; an
// expired session or one out of attempts is reopened from the same button.
// The confirmation screen appears only after the SERVER says the order is
// paid (it hears it from PayPlus) — never because the SDK said so.
//
// Without card payment (the test link where no PayPlus sandbox is configured
// — CI): nothing is saved before the button, which saves the order and ends
// it on the server ("סיים הזמנת בדיקה" — no charge), then the confirmation.

import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toPortalE164 } from '@/lib/portal/phone';
import {
  CHIP_ORDER_APT_LIMIT_MESSAGE, CHIP_ORDER_LIMITS, CHIP_ORDER_TEST_HEADER, LEASE_FILE_ACCEPT, formatIlsAfter, priceLine,
} from '@/lib/chipOrders/model';
import { leaseFileProblem } from '@/lib/chipOrders/lease';
import {
  CARD_TEXT, cardAmountChangedHint, cardFailureMessage, cardHolderPhone, sdkSaysPageExpired, sdkSaysRefused,
} from '@/lib/chipOrders/card';
import { PayPlusCardFields, type CardFieldsEvent, type CardFieldsHandle } from './PayPlusCardFields';
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

/** Everything the form holds: what a save sends, and the agreement boxes. */
interface FormValues {
  rows: Row[];
  phone: string;
  email: string;
  street: string;
  city: string;
  zip: string;
  note: string;
  agree: boolean;
  agreeRent: boolean;
}

/** The order as the server saved it last. */
interface SavedOrder {
  trackingToken: string;
  orderNumber: number;
  /** What the server priced it at — what a payment session charges. */
  total: number;
  /** The server's price per chip: that total over the chips (one flat price,
   *  re-read from /settings on every save — it may not be the page's). */
  unitPrice: number;
  /** What that save sent (contentHash): anything else is a change to save. */
  hash: string;
  /** The lease the server holds for a renter row (by the row's key) — sent
   *  as its key instead of the file while the row keeps that same file. */
  leases: Map<number, { file: File; key: string }>;
  /** The orderer's phone as the processor wants it (3-D Secure). */
  holderPhone: string;
  /** The rows as saved — the confirmation's summary. */
  confirmed: ConfirmedRow[];
}

/** The payment session the card fields are mounted for. */
interface LiveSession {
  trackingToken: string;
  amount: number;
}

/** The card section: no session yet → opening one → ready → a charge in
 *  flight (card or wallet) → the server confirming it. 'unverified' = sent
 *  and not confirmed yet; 'closed' = the session died (expired, out of
 *  attempts) or could not be opened — the button opens a new one. */
type CardPhase = 'none' | 'opening' | 'ready' | 'paying' | 'verifying' | 'unverified' | 'closed';
/** The button waits. */
const PHASE_BUSY: readonly CardPhase[] = ['opening', 'paying', 'verifying'];
/** A charge may be under way: the form is locked and nothing is saved. */
const PHASE_LOCKED: readonly CardPhase[] = ['paying', 'verifying', 'unverified'];
const CARD_BUTTON: Partial<Record<CardPhase, string>> = {
  opening: 'פותחים את התשלום…',
  paying: 'מבצעים את התשלום…',
  verifying: 'מאמתים את התשלום…',
  unverified: 'בדיקה חוזרת של התשלום',
  closed: CARD_TEXT.renew,
};
/** Rounds of "was it paid?" after the SDK reported a charge, 2.5s apart — and
 *  the shorter wait of a re-check the customer asked for. */
const CARD_VERIFY_ROUNDS = 14;
const CARD_RECHECK_ROUNDS = 4;
/** The automatic save waits this long after the last change. */
const AUTOSAVE_MS = 900;

const APT_MAX = CHIP_ORDER_LIMITS.maxChipsPerApartment;
const NOTE_MAX = CHIP_ORDER_LIMITS.customerNoteMax;
/** The server's rule for a person's name (chipOrderSubmitSchema). */
const NAME_LETTERS = /^[\p{L}\p{M}\s'׳"״.\-]+$/u;
/** The agreement boxes: they gate the payment, not the save. */
const BOX_KEYS = new Set(['agree', 'agreeRent']);

/** Two sums are the same to the agora. */
const sameAmount = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

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

/** Every problem of the form, by field ('agree' / 'agreeRent' = the boxes). */
function formErrors(v: FormValues, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  const perGroup = new Map<string, number>();
  for (const r of v.rows) perGroup.set(groupKey(r), (perGroup.get(groupKey(r)) ?? 0) + r.qty);
  for (const r of v.rows) {
    const name = r.name.trim();
    if (name.split(/\s+/).filter(Boolean).length < 2) e[`name_${r.key}`] = 'נדרש שם מלא — שם פרטי ושם משפחה';
    else if (!NAME_LETTERS.test(name)) e[`name_${r.key}`] = 'השם יכול להכיל אותיות בלבד';
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
  const leaseBytes = v.rows.reduce((s, r) => s + (r.role === 'tenant' ? r.file?.size ?? 0 : 0), 0);
  const lastRenter = [...v.rows].reverse().find((r) => r.role === 'tenant');
  if (leaseBytes > CHIP_ORDER_LIMITS.maxLeaseBytesTotal && lastRenter) e[`file_${lastRenter.key}`] = 'כל הקבצים יחד עד 40MB בהזמנה אחת';
  const e164 = toPortalE164(v.phone);
  if (!e164 || !e164.startsWith('+9725')) e.phone = 'נדרש מספר טלפון נייד ישראלי';
  if (!isEmail(v.email)) e.email = 'כתובת מייל לא תקינה';
  if (v.street.trim().length < 2) e.street = 'נדרשת כתובת מגורים';
  if (v.city.trim().length < 2) e.city = 'נדרשת עיר';
  if (!/^\d{7}$/.test(v.zip.trim())) e.zip = 'מיקוד — 7 ספרות';
  if (!v.agree) e.agree = 'נדרש לאשר שהפרטים נכונים';
  if (v.rows.some((r) => r.role === 'tenant') && !v.agreeRent) e.agreeRent = 'נדרש לאשר את התחייבות השוכר';
  return e;
}

/** The "order" part of a save, as the server reads it (chipOrderSubmitSchema). */
function orderBody(v: FormValues) {
  const hasRenter = v.rows.some((r) => r.role === 'tenant');
  return {
    phone: v.phone,
    email: v.email.trim(),
    addressStreet: v.street.trim(),
    addressCity: v.city.trim(),
    addressZip: v.zip.trim(),
    note: v.note.trim(),
    acceptTerms: v.agree,
    acceptRenterTerms: hasRenter ? v.agreeRent : false,
    rows: v.rows.map((r) => ({
      role: r.role,
      fullName: r.name.trim(),
      apartment: r.apt,
      chipsCount: r.qty,
      phone: r.phone,
      email: r.email.trim(),
      leaseEndDate: r.role === 'tenant' ? r.end || null : null,
    })),
  };
}

// A lease file counts by identity: the same File object = the same lease.
const fileIds = new WeakMap<File, number>();
let fileSeq = 0;
function fileId(f: File): number {
  let id = fileIds.get(f);
  if (id === undefined) {
    fileSeq += 1;
    id = fileSeq;
    fileIds.set(f, id);
  }
  return id;
}

/** What a save would send, as one string — a change in it is a new save. */
function contentHash(v: FormValues): string {
  return `${JSON.stringify(orderBody(v))}|${v.rows.map((r) => (r.role === 'tenant' && r.file ? fileId(r.file) : 0)).join(',')}`;
}

// A refused save's problems (zod issues of the server) → the form's fields.
const ROW_FIELD: Record<string, string> = {
  fullName: 'name', apartment: 'apt', chipsCount: 'qty', phone: 'phone', email: 'email', leaseEndDate: 'end', leaseKey: 'file',
};
const TOP_FIELD: Record<string, string> = {
  phone: 'phone', email: 'email', addressStreet: 'street', addressCity: 'city', addressZip: 'zip',
};
function issueErrors(issues: unknown, rowKeys: number[]): Record<string, string> | null {
  if (!Array.isArray(issues)) return null;
  const out: Record<string, string> = {};
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== 'string') continue;
    const [first, index, field] = path as unknown[];
    if (first === 'rows' && typeof index === 'number' && typeof field === 'string' && ROW_FIELD[field] && rowKeys[index] !== undefined) {
      out[`${ROW_FIELD[field]}_${rowKeys[index]}`] ??= message;
    } else if (typeof first === 'string' && TOP_FIELD[first]) {
      out[TOP_FIELD[first]] ??= message;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The answer of POST /api/public/chip-order. */
interface SaveAnswer {
  ok?: boolean;
  message?: string;
  state?: string;
  issues?: unknown;
  trackingToken?: string;
  orderNumber?: number;
  total?: number;
  leaseKeys?: (string | null)[];
}

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

function Err({ msg }: { msg?: string }) {
  return msg ? <span className="cr-err">{msg}</span> : null;
}

export function ChipOrderForm({
  apartments, pricing, termsText, testToken = null, cardPayment = false, receiptByEmail = false,
}: {
  apartments: string[];
  pricing: Pricing;
  termsText: string;
  /** Test mode: the token of the test link (the server checked it). */
  testToken?: string | null;
  /** The payment is the card (PayPlus hosted fields) and the wallet buttons —
   *  the sandbox behind the test link, production once real charging is armed. */
  cardPayment?: boolean;
  /** "הקבלה תישלח למייל לאחר התשלום" (under the form and the confirmation) —
   *  only when a receipt really goes out by email. */
  receiptByEmail?: boolean;
}) {
  const testHeaders: Record<string, string> = testToken ? { [CHIP_ORDER_TEST_HEADER]: testToken } : {};
  const seq = useRef(1);
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

  // What the fields show: every problem, live, once the pay button (or the
  // wallet row) was pressed; before that only the quantity limit of the plus
  // button and what the server refused a save for.
  const [attempted, setAttempted] = useState(false);
  const [qtyErrors, setQtyErrors] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<{ hash: string; errors: Record<string, string> } | null>(null);
  /** Above the pay button: what the button ran into. */
  const [serverError, setServerError] = useState<string | null>(null);
  /** In the payment section: an automatic save that failed. */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The pay button is saving / ending the order. */
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSavedState] = useState<SavedOrder | null>(null);
  /** The content whose automatic save failed — not saved again by itself. */
  const [failedHash, setFailedHash] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderNumber: number; total: number; rows: ConfirmedRow[] } | null>(null);

  // Card payment (PayPlus hosted fields + the wallet buttons)
  const cardRef = useRef<CardFieldsHandle>(null);
  const cardSection = useRef<HTMLElement>(null);
  const cardDead = useRef<'expired' | 'attempts' | null>(null);
  /** The last card charge ended with no answer from the SDK (its re-check keeps that rule). */
  const lastTimedOut = useRef(false);
  const [phase, setPhaseState] = useState<CardPhase>('none');
  const [session, setSessionState] = useState<LiveSession | null>(null);
  const [cardNote, setCardNote] = useState<string | null>(null);
  const [secure3d, setSecure3d] = useState(false);
  // The same, for the async flows (a closure holds the render it was made in).
  const phaseRef = useRef<CardPhase>('none');
  const sessionRef = useRef<LiveSession | null>(null);
  const savedRef = useRef<SavedOrder | null>(null);
  /** Saves run one after another; this is where the last one ends. */
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  /** The order of the charge in flight (card or wallet). */
  const payOrder = useRef<SavedOrder | null>(null);
  /** The pay button is saving: an automatic save leaves the fields to it. */
  const pressing = useRef(false);
  /** The order was saved again while its fields were opening: look after. */
  const reopenWanted = useRef(false);

  const values: FormValues = { rows, phone, email, street, city, zip, note, agree, agreeRent };
  const valuesRef = useRef(values);
  useEffect(() => { valuesRef.current = values; });

  function setPhase(p: CardPhase) {
    phaseRef.current = p;
    setPhaseState(p);
  }
  function setSession(s: LiveSession | null) {
    sessionRef.current = s;
    setSessionState(s);
  }
  function setSaved(s: SavedOrder) {
    savedRef.current = s;
    setSavedState(s);
  }

  // Chips per apartment (all its rows) — for the per-apartment maximum.
  const perGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(groupKey(r), (m.get(groupKey(r)) ?? 0) + r.qty);
    return m;
  }, [rows]);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const hasRenter = rows.some((r) => r.role === 'tenant');
  const problems = formErrors(values, todayIso());
  const detailsValid = Object.keys(problems).every((k) => BOX_KEYS.has(k));
  const formValid = Object.keys(problems).length === 0;
  const hash = contentHash(values);
  const dirty = saved === null || saved.hash !== hash;
  // What the button charges. One flat price: every chip of the order × the
  // price per chip — the SERVER's once the order was saved (it prices every
  // save anew, and the office may have changed it since this page loaded),
  // the page's until then. Saved and unchanged since → exactly the saved total.
  const unitPrice = saved?.unitPrice ?? pricing.unitPrice;
  const total = saved && !dirty ? saved.total : priceLine(totalQty, { unitPrice }).lineTotal;
  const locked = busy || PHASE_LOCKED.includes(phase);
  const errors: Record<string, string> = {
    ...(attempted ? problems : {}),
    ...(refused?.hash === hash ? refused.errors : {}),
    ...qtyErrors,
  };
  // The wallet buttons charge at once, with no hook: live only when the pay
  // button would charge at once too.
  const walletsArmed = cardPayment && phase === 'ready' && !busy && !saving && !dirty && formValid
    && saved !== null && session !== null && session.trackingToken === saved.trackingToken && session.amount === saved.total;

  // ── The automatic save (card payment only) ───────────────────────────────
  const autoSave = cardPayment && done === null && detailsValid && dirty && !busy && !saving
    && !PHASE_LOCKED.includes(phase) && failedHash !== hash;
  const onAutoSave = useEffectEvent(() => { void saveOrder(values, 'auto'); });
  useEffect(() => {
    if (!autoSave) return;
    const t = window.setTimeout(() => onAutoSave(), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [autoSave, hash]);

  function patchRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /** Clears the quantity message of every row of r's apartment. */
  function clearQtyErrors(r: Row) {
    const keys = rows.filter((x) => groupKey(x) === groupKey(r)).map((x) => `qty_${x.key}`);
    setQtyErrors((prev) => {
      if (!keys.some((k) => prev[k])) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  function addChip(r: Row) {
    if ((perGroup.get(groupKey(r)) ?? 0) + 1 > APT_MAX) {
      setQtyErrors((prev) => ({ ...prev, [`qty_${r.key}`]: CHIP_ORDER_APT_LIMIT_MESSAGE }));
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

  /** Every problem on the screen, the first one scrolled to. */
  function check(): boolean {
    setAttempted(true);
    if (formValid) return true;
    requestAnimationFrame(() => {
      document.querySelector('.cr-skin .cr-bad')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return false;
  }

  // ── Saving the order ─────────────────────────────────────────────────────
  /** Saves the order — a new one, or the saved one updated. One save at a
   *  time. Resolves with the saved order, or null (the reason is shown). */
  function saveOrder(v: FormValues, trigger: 'auto' | 'press'): Promise<SavedOrder | null> {
    const run = saveChain.current.then(() => postOrder(v, trigger, {}));
    saveChain.current = run.catch(() => null);
    return run;
  }

  /** The saved order for the form as it is: after the save in flight, and
   *  saved again when something changed since (or `force`). */
  async function savedFor(v: FormValues, trigger: 'auto' | 'press', force = false): Promise<SavedOrder | null> {
    await saveChain.current;
    const s = savedRef.current;
    if (s && !force && s.hash === contentHash(v)) return s;
    return saveOrder(v, trigger);
  }

  async function postOrder(
    v: FormValues, trigger: 'auto' | 'press', opts: { fresh?: boolean; resendLeases?: boolean; retried?: boolean },
  ): Promise<SavedOrder | null> {
    const prev = opts.fresh ? null : savedRef.current;
    const sentHash = contentHash(v);
    const body = orderBody(v);
    // A renter row that keeps the file the server already holds sends its key.
    const sentRows = body.rows.map((r, i) => {
      const row = v.rows[i];
      const held = prev && !opts.resendLeases && row.role === 'tenant' && row.file ? prev.leases.get(row.key) : undefined;
      return held && held.file === row.file ? { ...r, leaseKey: held.key } : r;
    });
    const fd = new FormData();
    fd.append('order', JSON.stringify({ ...body, rows: sentRows, ...(prev ? { trackingToken: prev.trackingToken } : {}) }));
    v.rows.forEach((row, i) => {
      if (row.role === 'tenant' && row.file && !('leaseKey' in sentRows[i])) fd.append(`lease_${i}`, row.file);
    });

    const fail = (message: string | null): null => {
      // The same content is not saved again by itself — the next change or press does.
      setFailedHash(sentHash);
      if (trigger === 'auto') {
        setSaveError(message);
      } else if (message) {
        setServerError(message);
      } else {
        // Refused on its fields: they show why.
        requestAnimationFrame(() => {
          document.querySelector('.cr-skin .cr-bad')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
      return null;
    };

    setSaving(true);
    try {
      let res: Response;
      try {
        res = await fetch('/api/public/chip-order', { method: 'POST', body: fd, headers: testHeaders });
      } catch {
        return fail(CARD_TEXT.saveOffline);
      }
      const data = (await res.json().catch(() => ({}))) as SaveAnswer;
      if (res.ok && data.ok && typeof data.trackingToken === 'string') {
        const leases = new Map<number, { file: File; key: string }>();
        (data.leaseKeys ?? []).forEach((key, i) => {
          const row = v.rows[i];
          if (key && row?.role === 'tenant' && row.file) leases.set(row.key, { file: row.file, key });
        });
        const chips = v.rows.reduce((s, r) => s + r.qty, 0);
        const priced = typeof data.total === 'number' ? data.total : priceLine(chips, pricing).lineTotal;
        const order: SavedOrder = {
          trackingToken: data.trackingToken,
          orderNumber: data.orderNumber ?? 0,
          total: priced,
          unitPrice: chips > 0 ? priced / chips : pricing.unitPrice,
          hash: sentHash,
          leases,
          holderPhone: cardHolderPhone(toPortalE164(v.phone)),
          confirmed: v.rows.map((r) => ({ apartment: r.apt, name: r.name.trim(), role: r.role, qty: r.qty })),
        };
        setSaved(order);
        setSaveError(null);
        setFailedHash(null);
        setRefused(null);
        if (cardPayment && trigger === 'auto' && !pressing.current) void syncSession(order);
        return order;
      }
      // A lease the server held is gone: every file goes again, once.
      if (data.state === 'lease_missing' && !opts.retried) return await postOrder(v, trigger, { ...opts, resendLeases: true, retried: true });
      // The saved order cannot change any more: a new order, once.
      if (data.state === 'not_pending' && prev && !opts.retried) return await postOrder(v, trigger, { ...opts, fresh: true, retried: true });
      // It was paid meanwhile: with card payment the server's status check
      // shows the confirmation; a test order without one was ended already.
      if (data.state === 'paid' && prev) {
        if (cardPayment) void verifyCard(prev);
        else setDone({ orderNumber: prev.orderNumber, total: prev.total, rows: prev.confirmed });
        return null;
      }
      const onFields = issueErrors(data.issues, v.rows.map((r) => r.key));
      if (onFields) setRefused({ hash: sentHash, errors: onFields });
      return fail(onFields ? null : data.message ?? CARD_TEXT.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  /** "סיים הזמנת בדיקה" on the server (a test order, no PayPlus sandbox) → the confirmation. */
  async function finishTestOrder(order: SavedOrder): Promise<void> {
    let res: Response;
    try {
      res = await fetch('/api/public/chip-order/test-finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...testHeaders },
        body: JSON.stringify({ trackingToken: order.trackingToken }),
      });
    } catch {
      throw new Error('סיום הזמנת הבדיקה נכשל. בדקו את החיבור לאינטרנט ונסו שוב.');
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok || !data.ok) throw new Error(data.message ?? 'סיום הזמנת הבדיקה נכשל');
    setDone({ orderNumber: order.orderNumber, total: order.total, rows: order.confirmed });
  }

  // ── Card payment ─────────────────────────────────────────────────────────
  async function cardApi(path: 'session' | 'status', trackingToken: string) {
    let res: Response;
    try {
      res = await fetch(`/api/public/chip-order/payplus/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...testHeaders },
        body: JSON.stringify({ trackingToken }),
      });
    } catch {
      throw new Error(CARD_TEXT.openFailed);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  }

  /** After an automatic save: the card fields follow the saved order — opened
   *  the first time, opened again when its total (or the order) changed. */
  async function syncSession(order: SavedOrder): Promise<void> {
    const p = phaseRef.current;
    if (p === 'opening') {
      reopenWanted.current = true;
      return;
    }
    // A charge may be under way, or the session died: the pay button decides.
    if (p !== 'none' && p !== 'ready') return;
    const s = sessionRef.current;
    if (p === 'ready' && s && s.trackingToken === order.trackingToken && s.amount === order.total) return;
    const hint = p === 'ready' && s ? (s.amount !== order.total ? cardAmountChangedHint(order.total) : CARD_TEXT.reopened)
      // The first time: priced at another price per chip than the page was loaded with — the new amount is said.
      : sameAmount(order.unitPrice, pricing.unitPrice) ? null : cardAmountChangedHint(order.total);
    await openCard(order, { hint });
  }

  /** Opens a payment session for the SAVED order and mounts the fields. */
  async function openCard(order: SavedOrder, opts: { hint?: string | null; fromPress?: boolean; repriced?: boolean }): Promise<void> {
    setPhase('opening');
    setSession(null);
    setCardNote(opts.hint ?? null);
    setSecure3d(false);
    cardDead.current = null;
    try {
      const { res, data } = await cardApi('session', order.trackingToken);
      if (data.state === 'paid') {
        // An earlier attempt turned out to be approved: nothing more to pay.
        await verifyCard(order);
        return;
      }
      if (data.state === 'price_changed' && !opts.repriced) {
        // The price per chip changed since the save: saved again (the server
        // prices it anew), and the session asked for once more.
        const again = await savedFor(valuesRef.current, 'press', true);
        if (!again) {
          setPhase('closed');
          setCardNote(null);
          return;
        }
        // The new amount is said under the fields before anything is charged.
        const hint = sameAmount(again.total, order.total) ? opts.hint : cardAmountChangedHint(again.total);
        await openCard(again, { ...opts, hint, repriced: true });
        return;
      }
      const { page_request_uid: uid, hosted_fields_uuid: uuid, origin, amount } = data;
      if (!res.ok || data.ok !== true || typeof uid !== 'string' || typeof uuid !== 'string' || typeof origin !== 'string') {
        throw new Error(typeof data.message === 'string' ? data.message : CARD_TEXT.openFailed);
      }
      try {
        await cardRef.current?.open({ page_request_uid: uid, hosted_fields_uuid: uuid, origin }, order.holderPhone);
      } catch {
        throw new Error(CARD_TEXT.sdkFailed);
      }
      setSession({ trackingToken: order.trackingToken, amount: typeof amount === 'number' ? amount : order.total });
      setPhase('ready');
      if (opts.fromPress) requestAnimationFrame(() => cardSection.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    } catch (err) {
      // Fields of an earlier session (another amount) never stay typeable.
      cardRef.current?.close();
      setPhase('closed');
      const message = (err as Error).message;
      if (opts.fromPress) {
        setCardNote(null);
        setServerError(message);
      } else {
        setCardNote(message);
      }
    } finally {
      if (reopenWanted.current) {
        reopenWanted.current = false;
        const latest = savedRef.current;
        if (latest && phaseRef.current === 'ready') void syncSession(latest);
      }
    }
  }

  /** "Was it paid?" — asked of OUR server, which hears it from PayPlus. Only
   *  its "paid" shows the confirmation screen. Returns 'paid', or what the
   *  last answer said about a charge: 'no' only when PayPlus itself ruled one
   *  out, 'unknown' otherwise. */
  async function askPaid(order: SavedOrder, rounds: number): Promise<'paid' | 'no' | 'unknown'> {
    let charged: 'no' | 'unknown' = 'unknown';
    for (let i = 0; i < rounds; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2500));
      try {
        const { res, data } = await cardApi('status', order.trackingToken);
        if (res.ok && data.state === 'paid') {
          cardRef.current?.close();
          setSession(null);
          setDone({ orderNumber: order.orderNumber, total: order.total, rows: order.confirmed });
          return 'paid';
        }
        // Only an answer for which the server asked PayPlus changes the verdict
        // (it asks once per 4 s; the rounds in between keep the last one).
        if (!res.ok || data.looked !== false) charged = res.ok && data.charged === 'no' ? 'no' : 'unknown';
      } catch {
        // A network hiccup: the next round asks again.
        charged = 'unknown';
      }
    }
    return charged;
  }

  /** After a charge that may have gone through: wait for the server's word.
   *  No confirmation in time → the customer may pay again ONLY when PayPlus
   *  ruled a charge out; otherwise only a re-check is offered. */
  async function verifyCard(order: SavedOrder, rounds = CARD_VERIFY_ROUNDS, timedOut = false): Promise<void> {
    setPhase('verifying');
    setCardNote(null);
    setServerError(null);
    const answer = await askPaid(order, rounds);
    if (answer === 'paid') return;
    if (answer === 'no') {
      // The SDK never answered and PayPlus ruled a charge out: that session is
      // unusable (disabled or expired at PayPlus without its event) — the
      // button opens a new one instead of sending into the dead one again.
      if (timedOut) cardDead.current ??= 'expired';
      setCardNote(timedOut ? CARD_TEXT.expired : CARD_TEXT.notCharged);
      setPhase(cardDead.current || !sessionRef.current ? 'closed' : 'ready');
      return;
    }
    setPhase('unverified');
    setCardNote(CARD_TEXT.unverified);
  }

  /** What a charge (card or wallet) answered → the server, or a refusal. */
  async function settle(order: SavedOrder, reply: unknown, via: 'card' | 'wallet'): Promise<void> {
    // Only a definite refusal is shown as one. A success, a timeout, or a
    // reply this page does not understand → the server is asked first.
    if (sdkSaysPageExpired(reply)) {
      // The page request is gone at PayPlus: one question to the server, then
      // a new session from the button (the details stay; the card is retyped).
      setPhase('verifying');
      if ((await askPaid(order, 1)) === 'paid') return;
      cardDead.current = 'expired';
      setServerError(null);
      setCardNote(CARD_TEXT.expired);
      setPhase('closed');
      return;
    }
    lastTimedOut.current = reply === 'timeout';
    if (!sdkSaysRefused(reply)) return verifyCard(order, CARD_VERIFY_ROUNDS, reply === 'timeout');
    // Refused — and still one question to the server before the button comes
    // back, in case PayPlus holds an approved charge of this order after all.
    setPhase('verifying');
    if ((await askPaid(order, 1)) === 'paid') return;
    // Everything typed stays; the order goes on waiting for payment.
    setServerError(cardFailureMessage(reply, via));
    if (cardDead.current || !sessionRef.current) {
      setCardNote(cardDead.current === 'expired' ? CARD_TEXT.expired : cardDead.current === 'attempts' ? CARD_TEXT.noAttempts : null);
      setPhase('closed');
    } else {
      setCardNote(null);
      setPhase('ready');
    }
  }

  async function payCard(order: SavedOrder): Promise<void> {
    setServerError(null);
    setCardNote(null);
    payOrder.current = order;
    setPhase('paying');
    const reply = await cardRef.current?.pay();
    if (reply == null) {
      // Our own fields (holder name / ID) stopped it; nothing was sent.
      setPhase(cardDead.current ? 'closed' : 'ready');
      return;
    }
    await settle(order, reply, 'card');
  }

  function onCardEvent(e: CardFieldsEvent) {
    if (e.type === 'secure3d') {
      setSecure3d(e.open);
    } else if (e.type === 'dead') {
      cardDead.current = e.why;
      setCardNote(e.why === 'expired' ? CARD_TEXT.expired : CARD_TEXT.noAttempts);
      // A charge in flight ends with its own result; an idle session closes now.
      if (phaseRef.current === 'ready') {
        setSession(null);
        setPhase('closed');
      }
    } else if (e.type === 'wallet-start') {
      // Armed only when everything is saved: the charge is for the saved order.
      payOrder.current = savedRef.current;
      setServerError(null);
      setCardNote(CARD_TEXT.walletPaying);
      setPhase('paying');
    } else {
      // A wallet's result (or a card result that came after pay() gave up).
      const order = payOrder.current ?? savedRef.current;
      if (!order || phaseRef.current === 'verifying') return;
      void settle(order, e.reply, 'wallet');
    }
  }

  // ── The pay button ───────────────────────────────────────────────────────
  async function onPay(): Promise<void> {
    // `pressing` also stops a second press of the same moment (before `busy` renders).
    if (busy || done || pressing.current) return;
    const p = phaseRef.current;
    if (PHASE_BUSY.includes(p)) return;
    setServerError(null);
    if (p === 'unverified') {
      const order = payOrder.current ?? savedRef.current;
      if (order) await verifyCard(order, CARD_RECHECK_ROUNDS, lastTimedOut.current);
      return;
    }
    if (!check()) return;
    pressing.current = true;
    setBusy(true);
    let order: SavedOrder | null = null;
    try {
      // A dead session: the order is saved again first (it may have been closed since).
      order = await savedFor(values, 'press', p === 'closed');
      if (order && !cardPayment) await finishTestOrder(order);
    } catch (err) {
      setServerError((err as Error).message);
      order = null;
    } finally {
      pressing.current = false;
      setBusy(false);
    }
    if (!order || !cardPayment) return;
    // The button showed another amount than the order was saved at (the price
    // per chip changed since): nothing is charged before the new one is said.
    const moved = !sameAmount(order.total, total);
    // A live session of exactly this order and amount → the charge.
    const s = sessionRef.current;
    const now = phaseRef.current;
    if (!moved && now === 'ready' && s && s.trackingToken === order.trackingToken && s.amount === order.total) {
      await payCard(order);
      return;
    }
    // Already opening, or a payment check runs: nothing to start here.
    if (now === 'opening' || PHASE_LOCKED.includes(now)) return;
    // The fields open for this order and amount, and the button stops here:
    // the processor's frames are empty until the card is typed into them.
    const hint = moved || (now === 'ready' && s && s.amount !== order.total) ? cardAmountChangedHint(order.total)
      : now === 'ready' && s ? CARD_TEXT.reopened : CARD_TEXT.typeCard;
    await openCard(order, { hint, fromPress: true });
  }

  /** A tap on the wallet row while it may not charge: what is missing shows;
   *  complete but not saved → saved now (the fields follow the save). */
  function onWalletGate() {
    if (busy || done || PHASE_BUSY.includes(phase) || PHASE_LOCKED.includes(phase)) return;
    if (!check()) return;
    if (dirty || saving) void savedFor(values, 'auto');
    else if (phase === 'closed') void onPay();
  }

  // ── Confirmation ─────────────────────────────────────────────────────────
  if (done) {
    return (
      <>
        <ChipOrderConfirmation orderNumber={done.orderNumber} rows={done.rows} total={done.total} />
        {receiptByEmail && <p className="cr-foot">הקבלה תישלח למייל לאחר התשלום</p>}
      </>
    );
  }

  // The one line under the card fields: what is happening to them now.
  const cardHint = !cardPayment ? CARD_TEXT.testNoCard
    : secure3d ? CARD_TEXT.secure3d
      : phase === 'opening' ? CARD_TEXT.loading
        : phase === 'verifying' ? CARD_TEXT.verifying
          : cardNote ?? (phase === 'none' ? CARD_TEXT.idle : null);
  const buttonBusy = busy || PHASE_BUSY.includes(phase);
  const buttonText = CARD_BUTTON[phase];

  // ── The form ─────────────────────────────────────────────────────────────
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => { e.preventDefault(); void onPay(); }}
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
                      <input id={`co-name-${r.key}`} type="text" value={r.name} placeholder="שם המזמין" autoComplete="name" maxLength={120} disabled={locked}
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
                      <input id={`co-phone-${r.key}`} type="tel" inputMode="tel" autoComplete="tel" value={r.phone} maxLength={20} disabled={locked}
                        className={cn('cr-num cr-ltr', errors[`phone_${r.key}`] && 'cr-bad')} onChange={(e) => patchRow(r.key, { phone: e.target.value })} />
                      <Err msg={errors[`phone_${r.key}`]} />
                    </div>
                    <div className="cr-fld">
                      <label htmlFor={`co-email-${r.key}`}>מייל</label>
                      <input id={`co-email-${r.key}`} type="email" inputMode="email" autoComplete="email" value={r.email} maxLength={254} disabled={locked}
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
          {totalQty > 0 && (
            <div className="cr-brk" data-testid="chip-order-breakdown">
              <div className="cr-bh"><span>פריט</span><span className="cr-c">כמות</span><span className="cr-c">מחיר ליחידה</span><span className="cr-t">סה&quot;כ</span></div>
              <div className="cr-br">
                <span>כרטיס בקרת כניסה</span>
                <span className="cr-c cr-num">{totalQty}</span>
                <span className="cr-c cr-num">{formatIlsAfter(unitPrice)}</span>
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
              <input id="co-phone" type="tel" inputMode="tel" autoComplete="tel" required value={phone} maxLength={20} disabled={locked}
                className={cn('cr-num cr-ltr', errors.phone && 'cr-bad')} onChange={(e) => setPhone(e.target.value)} />
              <Err msg={errors.phone} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-email">מייל <span className="cr-req">*</span></label>
              <input id="co-email" type="email" inputMode="email" autoComplete="email" required value={email} maxLength={254} disabled={locked}
                className={cn('cr-num cr-ltr', errors.email && 'cr-bad')} onChange={(e) => setEmail(e.target.value)} />
              <Err msg={errors.email} />
            </div>
          </div>
          <div className="cr-addrrow">
            <div className="cr-fld">
              <label htmlFor="co-street">כתובת מגורים נוכחית (רחוב ומספר בית) <span className="cr-req">*</span></label>
              <input id="co-street" type="text" required placeholder="לדוגמה: דוד אלעזר 10" autoComplete="street-address" value={street} maxLength={200} disabled={locked}
                className={cn(errors.street && 'cr-bad')} onChange={(e) => setStreet(e.target.value)} />
              <Err msg={errors.street} />
            </div>
            <div className="cr-fld">
              <label htmlFor="co-city">עיר <span className="cr-req">*</span></label>
              <input id="co-city" type="text" required placeholder="חיפה" autoComplete="address-level2" value={city} maxLength={100} disabled={locked}
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

      {/* אישור ותשלום — the wallet buttons and PayPlus's hosted card fields,
          live once the order is saved. Before that (and in the test mode
          without a PayPlus sandbox) the boxes are drawn but not typeable. */}
      <section className="cr-card" data-testid="chip-order-card-fields" ref={cardSection}>
        <div className="cr-chead">
          <span className="cr-cic cr-green"><ShieldIcon /></span>
          <div><b>אישור ותשלום</b><small>תשלום מאובטח בכרטיס אשראי</small></div>
        </div>
        <div className="cr-cbody cr-cbody-tight">
          {(saving || saved) && (
            <p className="cr-ppinfo" role="status" data-testid="chip-order-saved">
              {saving || !saved ? CARD_TEXT.saving : (
                <>
                  הזמנה <span className="cr-num">{saved.orderNumber}</span> נשמרה וממתינה לתשלום — סה&quot;כ{' '}
                  <span className="cr-num">{formatIlsAfter(saved.total)}</span>
                </>
              )}
            </p>
          )}
          {saveError && <p role="alert" className="cr-alert cr-alert-top" data-testid="chip-order-save-error">{saveError}</p>}
          <PayPlusCardFields
            ref={cardRef}
            active={phase === 'ready' || phase === 'paying'}
            onEvent={onCardEvent}
            wallets={{ armed: walletsArmed, onGate: onWalletGate }}
          />
          {cardHint && <p className="cr-pphint" role="status" data-testid="chip-order-card-hint">{cardHint}</p>}
          {secure3d && <div className="cr-3ds-backdrop" aria-hidden="true" />}
          <div className="cr-secure">
            <LockIcon size={14} sw={2.2} />
            הפרטים מוצפנים ומאובטחים — העסקה מבוצעת בתקן PCI‑DSS
          </div>
        </div>
      </section>

      {/* Agreement + pay */}
      <section className="cr-card">
        <div className="cr-cbody">
          {termsText.trim() && (
            <details className="cr-terms">
              <summary>תנאי ההזמנה</summary>
              <p>{termsText}</p>
            </details>
          )}
          <label className={cn('cr-agree', errors.agree && 'cr-bad')}>
            <input type="checkbox" checked={agree} disabled={locked} onChange={(e) => setAgree(e.target.checked)} />
            <span>אני מאשר שהפרטים שמסרתי הינם נכונים.</span>
          </label>
          {hasRenter && (
            <label className={cn('cr-agree', errors.agreeRent && 'cr-bad')}>
              <input type="checkbox" checked={agreeRent} disabled={locked} onChange={(e) => setAgreeRent(e.target.checked)} />
              <span>השוכר מתחייב להחזיר את הכרטיס ולא לעשות בו שימוש לאחר סיום תקופת השכירות.</span>
            </label>
          )}

          {serverError && <div role="alert" className="cr-alert">{serverError}</div>}

          <button type="submit" className="cr-submit" disabled={buttonBusy || !agree || (hasRenter && !agreeRent)} data-testid="chip-order-pay">
            {buttonBusy ? <Loader2 className="h-[17px] w-[17px] cr-spin" /> : <LockIcon />}
            {buttonText
              ? <span>{buttonText}</span>
              : <span>תשלום מאובטח — <b className="cr-num">{formatIlsAfter(total)}</b></span>}
          </button>
          {(errors.agree || errors.agreeRent) && <p className="cr-err mt-2">{errors.agree ?? errors.agreeRent}</p>}
        </div>
      </section>
      {receiptByEmail && <p className="cr-foot">הקבלה תישלח למייל לאחר התשלום</p>}
    </form>
  );
}
