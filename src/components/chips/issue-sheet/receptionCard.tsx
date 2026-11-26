'use client';

// "אשראי" at the reception (26/11/2026) — the card payment of the issue window
// without an order. Admin and super admin only: the server decides who is
// shown the option (GET /api/chips/reception → card_option) and every route
// asks the role again (requireAdmin).
//
// The same rules as the public order page, through the same component
// (PayPlusCardFields — card only, no wallet buttons here):
//   · the amount is the SERVER's: the new chips of the window × the price of
//     /settings, frozen on a reception order that waits for the payment
//     (POST /api/chips/reception/card). The window shows what it answered;
//   · the processor's frames take the card; "חיוב ₪N" submits it;
//   · what the SDK reports never pays anything: the window asks OUR server
//     (POST /api/chips/reception/card/status), which asks PayPlus. A definite
//     refusal keeps the fields (the card can be typed again); no answer → "בדוק
//     שוב", and never a second charge offered;
//   · a change of the new chips after the session opened opens a new one (the
//     server prices it anew); the orderer's details and the holders' roles go
//     to the order with the save, so they need no new session — except the
//     orderer's phone, which the card issuer's 3-D Secure check reads from the
//     fields: a new phone opens the session again (the same order, `token`);
//   · "חיוב" charges only a session opened for the window as it is now (the
//     chips, the mode, the phone): a press on an older one opens it again
//     instead, and a change made while a session opened or a charge ran renews
//     it once it waits again — never in the middle of a charge. While a charge
//     is in flight or not confirmed the window holds still (`onCharging`);
//   · TEST mode — clearly marked, amber: the PayPlus sandbox and a TEST
//     reception order. It never issues chips (the save refuses it); it is
//     cancelled and refunded in the sandbox from here. When real charging is
//     off, the card works in test mode only.
// Paid for real → the card part is locked and the window's "שמור" issues the
// chips onto that paid order (the method, the amount the card paid, and the
// order's token travel with the save).

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { PayPlusCardFields, type CardFieldsEvent, type CardFieldsHandle } from '@/components/chip-order/PayPlusCardFields';
import { CARD_TEXT, cardFailureMessage, cardHolderPhone, sdkSaysPageExpired, sdkSaysRefused } from '@/lib/chipOrders/card';
import { formatIlsAfter } from '@/lib/chipOrders/model';
import { RECEPTION_MAX_PAID_CHIPS, type OrdererFields } from '@/lib/chipOrders/reception';
import { toPortalE164 } from '@/lib/portal/phone';
import { AlertIco, CheckIco } from './parts';

/** The card payment of the window, as the window keeps it: the reception
 *  order it pays (its token travels with the save), what was charged, for how
 *  many chips, in which environment — and whether the server saw it paid. */
export interface ReceptionCardState {
  token: string;
  orderId: string;
  orderNumber: number;
  amount: number;
  chips: number;
  test: boolean;
  paid: boolean;
}

/** Why the window cannot be saved with "אשראי" yet — null when it can. */
export function receptionCardReason(card: ReceptionCardState | null, newChips: number): string | null {
  if (newChips === 0) return null;
  if (!card?.paid) return 'יש להשלים את התשלום באשראי לפני השמירה';
  if (card.test) return 'תשלום בדיקה אינו מנפיק צ׳יפים — יש לבטל אותו (זיכוי בסביבת הבדיקות) כדי להמשיך';
  if (card.chips !== newChips) return 'הסכום שנגבה באשראי אינו הסכום לתשלום עכשיו — יש להחזיר את מספר הצ׳יפים, או לבטל את ההזמנה (זיכוי)';
  return null;
}

/** The card section: nothing yet (or something is missing) → opening a
 *  session → ready → a charge in flight → the server confirming it.
 *  'unverified' = sent and not confirmed; 'closed' = the session died or could
 *  not be opened — the button opens a new one; 'paid' = the server saw it. */
type Phase = 'none' | 'opening' | 'ready' | 'paying' | 'verifying' | 'unverified' | 'closed' | 'paid';
const BUSY: readonly Phase[] = ['opening', 'paying', 'verifying'];
/** A charge may be under way — sent and not settled: the window holds still
 *  (IssueChipSheet: no other method, no other apartment, closing asks first). */
const CHARGING: readonly Phase[] = ['paying', 'verifying', 'unverified'];
/** Rounds of "was it paid?" after a charge, 2.5s apart; the shorter re-check. */
const VERIFY_ROUNDS = 14;
const RECHECK_ROUNDS = 4;
/** A change of the chips (or the phone) opens the session again this long after the last one. */
const RENEW_MS = 900;

const TEXT = {
  typeCard: 'יש להזין את פרטי הכרטיס וללחוץ על „חיוב”.',
  unverified: 'החיוב נשלח, אבל עדיין לא התקבל עליו אישור מ-PayPlus. אין לחייב שוב — אפשר לבדוק שוב בעוד רגע.',
  testOnly: 'חיוב אמיתי כבוי — האשראי פועל כאן במצב בדיקה בלבד.',
  testSwitch: 'מצב בדיקה — סביבת הבדיקות, ללא חיוב',
  testCancelReason: 'בדיקת אשראי בקבלה',
} as const;

interface SessionAnswer {
  ok?: boolean;
  error?: string;
  state?: 'paid' | 'stale';
  token?: string;
  order_id?: string;
  order_number?: number;
  amount?: number;
  test?: boolean;
  session?: { page_request_uid?: string; hosted_fields_uuid?: string; origin?: string };
}

interface StatusAnswer {
  ok?: boolean;
  state?: 'paid' | 'pending' | 'failed';
  charged?: 'no' | 'unknown';
  /** PayPlus was asked for this answer (false = the per-order 4 s limit). */
  looked?: boolean;
  amount?: number;
  order_number?: number;
  order_id?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ReceptionCardPanel({
  contactId, newChips, amount, role, orderer, live, testAvailable, disabled, card, onCard, onCharging,
}: {
  contactId: string;
  /** New chips in the save — what the card pays for. */
  newChips: number;
  /** chips × the price of /settings, as the window shows it (null = not loaded). */
  amount: number | null;
  /** The role of the first chip holder of the save (the order's role). */
  role: string;
  /** The orderer as the window shows it (name and phone follow the first holder). */
  orderer: OrdererFields;
  /** Real charging is armed (PayPlus production + the live switch). */
  live: boolean;
  /** The PayPlus sandbox is configured — the test mode can be used. */
  testAvailable: boolean;
  disabled: boolean;
  card: ReceptionCardState | null;
  onCard: (c: ReceptionCardState | null) => void;
  /** A charge is in flight or not confirmed yet (CHARGING) — told with every phase. */
  onCharging: (charging: boolean) => void;
}) {
  const fields = useRef<CardFieldsHandle>(null);
  const [phase, setPhaseState] = useState<Phase>('none');
  const phaseRef = useRef<Phase>('none');
  // The latest `onCharging` — setPhase runs from async work and effects.
  const onChargingRef = useRef(onCharging);
  useEffect(() => { onChargingRef.current = onCharging; }, [onCharging]);
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); onChargingRef.current(CHARGING.includes(p)); };
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [secure3d, setSecure3d] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Real charging off → test mode only.
  const [testChoice, setTestChoice] = useState(false);
  const test = !live || testChoice;
  const dead = useRef<'expired' | 'attempts' | null>(null);
  const openSeq = useRef(0);
  /** What the open session was opened for (chips · mode · phone). */
  const openedKey = useRef<string | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;

  // The card issuer's 3-D Secure check reads the holder's phone from the
  // fields: the orderer's, in the processor's form (9725…), or none.
  const holderPhone = cardHolderPhone(toPortalE164(orderer.phone.trim()));
  const key = `${newChips}|${test ? 'test' : 'live'}|${holderPhone}`;

  const blocker = !live && !testAvailable ? null // the option is off altogether (not drawn enabled)
    : amount === null ? 'המחיר לצ׳יפ לא נטען — סגרו את החלון ופתחו אותו שוב'
      : newChips < 1 ? 'אין צ׳יפים חדשים לתשלום בשמירה הזו'
        : newChips > RECEPTION_MAX_PAID_CHIPS ? `בתשלום בקבלה אפשר להנפיק עד ${RECEPTION_MAX_PAID_CHIPS} צ׳יפים בשמירה אחת`
          : orderer.name.trim().length < 2 ? 'יש למלא שם מזמין (לפחות שתי אותיות) לפני תשלום באשראי'
            : null;

  function fail(message: string) {
    fields.current?.close();
    openedKey.current = null;
    setPhase('closed');
    setError(message);
  }

  /** Opens a payment session and mounts the fields. `token` = the same order
   *  again (its session expired, or the phone changed); without it the server
   *  makes a new reception order for the chips of the window now. */
  async function openSession(token: string | null): Promise<void> {
    const mine = ++openSeq.current;
    setPhase('opening');
    setError(null);
    setNote(null);
    setSecure3d(false);
    dead.current = null;
    const forKey = key;
    let res: Response;
    let data: SessionAnswer;
    try {
      res = await fetch('/api/chips/reception/card', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          new_chips: newChips,
          test,
          role,
          orderer: {
            name: orderer.name.trim() || null, phone: orderer.phone.trim() || null, email: orderer.email.trim() || null,
            street: orderer.street.trim() || null, city: orderer.city.trim() || null, zip: orderer.zip.trim() || null,
          },
          ...(token ? { token } : {}),
        }),
      });
      data = (await res.json().catch(() => ({}))) as SessionAnswer;
    } catch {
      if (mine === openSeq.current) fail(CARD_TEXT.openFailed);
      return;
    }
    if (mine !== openSeq.current) return;
    if (token && res.status === 409 && data.state === 'paid') {
      // An earlier attempt of this order was approved after all.
      await verifyCard(token, RECHECK_ROUNDS);
      return;
    }
    if (token && res.status === 409 && data.state === 'stale') {
      // The order no longer waits (or its chips are others): a new one.
      await openSession(null);
      return;
    }
    const s = data.session;
    if (!res.ok || data.ok !== true || !data.token || !data.order_id || typeof data.order_number !== 'number'
      || typeof data.amount !== 'number' || !s?.page_request_uid || !s.hosted_fields_uuid || !s.origin) {
      fail(data.error ?? CARD_TEXT.openFailed);
      return;
    }
    onCard({ token: data.token, orderId: data.order_id, orderNumber: data.order_number, amount: data.amount, chips: newChips, test: data.test === true, paid: false });
    try {
      await fields.current?.open({ page_request_uid: s.page_request_uid, hosted_fields_uuid: s.hosted_fields_uuid, origin: s.origin }, holderPhone);
    } catch {
      if (mine === openSeq.current) fail(CARD_TEXT.sdkFailed);
      return;
    }
    if (mine !== openSeq.current) return;
    openedKey.current = forKey;
    setNote(TEXT.typeCard);
    setPhase('ready');
  }

  /** "Was it paid?" — asked of OUR server, which hears it from PayPlus. */
  async function askPaid(token: string, rounds: number): Promise<'paid' | 'no' | 'unknown'> {
    let charged: 'no' | 'unknown' = 'unknown';
    for (let i = 0; i < rounds; i++) {
      if (i > 0) await sleep(2500);
      try {
        const res = await fetch('/api/chips/reception/card/status', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json().catch(() => ({}))) as StatusAnswer;
        if (res.ok && data.state === 'paid' && typeof data.amount === 'number') {
          fields.current?.close();
          openedKey.current = null;
          const was = cardRef.current;
          onCard({
            token,
            orderId: data.order_id ?? was?.orderId ?? '',
            orderNumber: data.order_number ?? was?.orderNumber ?? 0,
            amount: data.amount,
            chips: was?.token === token ? was.chips : newChips,
            test: was?.token === token ? was.test : test,
            paid: true,
          });
          setNote(null);
          setError(null);
          setPhase('paid');
          return 'paid';
        }
        // Only an answer for which the server asked PayPlus changes the verdict.
        if (!res.ok || data.looked !== false) charged = res.ok && data.charged === 'no' ? 'no' : 'unknown';
      } catch {
        charged = 'unknown';
      }
    }
    return charged;
  }

  /** After a charge that may have gone through: wait for the server's word.
   *  A new charge is offered ONLY when PayPlus ruled one out. */
  async function verifyCard(token: string, rounds = VERIFY_ROUNDS, timedOut = false): Promise<void> {
    setPhase('verifying');
    setNote(null);
    setError(null);
    const answer = await askPaid(token, rounds);
    if (answer === 'paid') return;
    if (answer === 'no') {
      // No answer from the SDK and nothing charged: that session is unusable.
      if (timedOut) dead.current ??= 'expired';
      setNote(timedOut ? CARD_TEXT.expired : CARD_TEXT.notCharged);
      setPhase(dead.current || !openedKey.current ? 'closed' : 'ready');
      return;
    }
    setPhase('unverified');
    setNote(TEXT.unverified);
  }

  /** What the charge answered → the server, or a refusal. */
  async function settle(token: string, reply: unknown): Promise<void> {
    // Only a definite refusal is shown as one; anything else asks the server.
    if (sdkSaysPageExpired(reply)) {
      // The page request is gone at PayPlus: ask once, then a new session.
      setPhase('verifying');
      if ((await askPaid(token, 1)) === 'paid') return;
      dead.current = 'expired';
      setError(null);
      setNote(CARD_TEXT.expired);
      setPhase('closed');
      return;
    }
    if (!sdkSaysRefused(reply)) return verifyCard(token, VERIFY_ROUNDS, reply === 'timeout');
    setPhase('verifying');
    if ((await askPaid(token, 1)) === 'paid') return;
    // The card can be typed again; nothing else changes.
    setError(cardFailureMessage(reply));
    if (dead.current) {
      setNote(dead.current === 'expired' ? CARD_TEXT.expired : CARD_TEXT.noAttempts);
      setPhase('closed');
    } else {
      setNote(null);
      setPhase('ready');
    }
  }

  async function pay(): Promise<void> {
    const c = cardRef.current;
    if (phaseRef.current !== 'ready' || !c || disabled) return;
    // A session opened for other chips, another mode or another phone is
    // never charged: the one for the window as it is now opens instead.
    if (openedKey.current !== key) {
      reopen();
      return;
    }
    setError(null);
    setNote(null);
    setPhase('paying');
    const reply = await fields.current?.pay();
    if (reply == null) {
      // The holder's name / ID (our own two fields) stopped it; nothing was sent.
      setPhase(dead.current ? 'closed' : 'ready');
      return;
    }
    await settle(c.token, reply);
  }

  function onEvent(e: CardFieldsEvent) {
    if (e.type === 'secure3d') {
      setSecure3d(e.open);
    } else if (e.type === 'dead') {
      dead.current = e.why;
      setNote(e.why === 'expired' ? CARD_TEXT.expired : CARD_TEXT.noAttempts);
      if (phaseRef.current === 'ready') {
        openedKey.current = null;
        setPhase('closed');
      }
    } else if (e.type === 'wallet-result') {
      // A card result that came after pay() gave up on it (no wallets here).
      const c = cardRef.current;
      if (c && phaseRef.current !== 'verifying' && phaseRef.current !== 'paid') void settle(c.token, e.reply);
    }
  }

  /** The session to open now: the same order when it is still for these
   *  chips and this mode, else a new one. */
  function reopen() {
    const c = cardRef.current;
    void openSession(c && !c.paid && c.chips === newChips && c.test === test ? c.token : null);
  }

  // Something the card needs went missing (chips, the name, the price): the
  // fields close, and open again once it is back.
  useEffect(() => {
    if (blocker === null || card?.paid) return;
    if (phaseRef.current === 'ready' || phaseRef.current === 'closed') {
      openSeq.current += 1;
      fields.current?.close();
      openedKey.current = null;
      setError(null);
      setNote(null);
      setPhase('none');
    }
  }, [blocker, card?.paid]);

  // Open the session when the card is chosen and everything is there; open it
  // again (after a pause) when the chips, the mode or the phone changed — also
  // a change made while it was opening or a charge ran: `phase` brings the
  // check back once the session waits ('ready') again. A charge pressed
  // meanwhile is never torn down: the timer renews only a session that waits.
  useEffect(() => {
    if (blocker !== null || disabled || card?.paid || (!live && !testAvailable)) return;
    const p = phaseRef.current;
    if (p === 'none') {
      reopen();
      return;
    }
    if (p !== 'ready' || openedKey.current === key) return;
    const t = window.setTimeout(() => { if (phaseRef.current === 'ready') reopen(); }, RENEW_MS);
    return () => window.clearTimeout(t);
    // `reopen` reads the latest values through refs and props of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, blocker, disabled, card?.paid, live, testAvailable, phase]);

  /** "בטל וזכה בסביבת הבדיקות" — a paid TEST order is cancelled and refunded
   *  in the sandbox (POST …/cancel); it never issues chips. */
  async function cancelTest(): Promise<void> {
    const c = cardRef.current;
    if (!c?.paid || !c.test) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/chip-orders/${c.orderId}/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: TEXT.testCancelReason }),
      });
      // "ביטול וזיכוי" (27/11/2026): the refund comes first — a refund that did
      // not go through stops the run there, and the order stays paid (the card
      // stays on screen; pressing again runs what is left — never a second refund).
      const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean; message?: string | null };
      if (!res.ok) throw new Error(data.error ?? 'הביטול נכשל');
      if (!data.ok) {
        const stopped = `הזמנת הבדיקה ${c.orderNumber} לא בוטלה — הזיכוי בסביבת הבדיקות לא בוצע: ${data.message ?? 'נסו שוב'}`;
        toast.warning(stopped);
        setError(stopped);
        return;
      }
      const outcome = `הזמנת הבדיקה ${c.orderNumber} בוטלה וזוכתה במלואה בסביבת הבדיקות.`;
      toast.success(outcome);
      onCard(null);
      openedKey.current = null;
      setError(null);
      setNote(outcome);
      // A new payment opens only when asked for.
      setPhase('closed');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const paid = card?.paid === true;
  const busy = BUSY.includes(phase);
  // The open session is for other chips or another mode than the window shows
  // now: it is about to open again, and its sum is not drawn on the button.
  const renewing = phase === 'ready' && card !== null && (card.chips !== newChips || card.test !== test);
  // The fields show while a session is being opened or is open — never under a blocker.
  const showFields = !paid && phase !== 'none' && blocker === null;
  const hint = secure3d ? CARD_TEXT.secure3d
    : phase === 'opening' || renewing ? CARD_TEXT.loading
      : phase === 'verifying' ? CARD_TEXT.verifying
        : note;

  return (
    <div className="ci-cardpay" data-testid="chip-reception-card">
      {testAvailable && (
        // The whole amber row is the switch's label: a 44px target, not just the switch.
        <label className="ci-cardtest" data-testid="chip-reception-card-test">
          <span className="ci-cardtest-txt">
            <b>{TEXT.testSwitch}</b>
            {!live && <small>{TEXT.testOnly}</small>}
          </span>
          <Switch
            checked={test}
            onCheckedChange={(v) => setTestChoice(v === true)}
            disabled={!live || paid || busy || disabled || phase === 'unverified'}
            aria-label={TEXT.testSwitch}
          />
        </label>
      )}

      {paid && card ? (
        card.test ? (
          <div className="ci-cardpaid ci-test" role="status" data-testid="chip-reception-card-paid">
            <p>
              <AlertIco size={14} />
              <span>תשלום הבדיקה התקבל (הזמנת בדיקה <span className="ci-num">{card.orderNumber}</span>) — בדיקה אינה מנפיקה צ׳יפים</span>
            </p>
            <button type="button" className="ci-btn ci-danger" disabled={cancelling || disabled} onClick={() => void cancelTest()}
              data-testid="chip-reception-card-cancel-test">
              {cancelling && <Loader2 className="ci-spin h-3.5 w-3.5" />}
              בטל וזכה בסביבת הבדיקות
            </button>
          </div>
        ) : (
          <div className="ci-cardpaid" role="status" data-testid="chip-reception-card-paid">
            <p>
              <CheckIco />
              <span>שולם באשראי <span className="ci-num">{formatIlsAfter(card.amount)}</span> · הזמנה <span className="ci-num">{card.orderNumber}</span></span>
            </p>
            <small>„שמור” מנפיק את הצ׳יפים על ההזמנה הזו.</small>
          </div>
        )
      ) : blocker !== null ? (
        <p className="ci-reason ci-flat" role="status" data-testid="chip-reception-card-blocker">
          <AlertIco size={13} />
          <span>{blocker}</span>
        </p>
      ) : null}

      {/* The processor's fields: mounted while the card is the method and not paid —
          inert until a session is open (`active`). */}
      {!paid && (
        <div className="cr-skin ci-crbox" hidden={!showFields}>
          <PayPlusCardFields ref={fields} active={phase === 'ready' || phase === 'paying'} onEvent={onEvent} />
          {secure3d && <div className="cr-3ds-backdrop" aria-hidden="true" />}
        </div>
      )}

      {!paid && error && <div className="ci-alert" role="alert" data-testid="chip-reception-card-error">{error}</div>}
      {!paid && hint && (
        <p className="ci-reason ci-flat ci-quiet" role="status" data-testid="chip-reception-card-hint">
          <AlertIco size={13} />
          <span>{hint}</span>
        </p>
      )}

      {/* 'unverified' keeps its "בדוק שוב" even under a blocker: a charge may
          have gone through, and the window is locked until it is settled. */}
      {!paid && (blocker === null || phase === 'unverified') && phase !== 'none' && (
        <div className="ci-cardact">
          {phase === 'unverified' ? (
            <button type="button" className="ci-btn ci-line" disabled={disabled} onClick={() => card && void verifyCard(card.token, RECHECK_ROUNDS)}
              data-testid="chip-reception-card-recheck">
              בדוק שוב
            </button>
          ) : phase === 'closed' ? (
            <button type="button" className="ci-btn ci-line" disabled={disabled} onClick={reopen} data-testid="chip-reception-card-renew">
              {CARD_TEXT.renew}
            </button>
          ) : (
            <button type="button" className="ci-btn ci-primary ci-cardcharge" disabled={disabled || phase !== 'ready' || renewing}
              onClick={() => void pay()} data-testid="chip-reception-card-charge">
              {(busy || renewing) && <Loader2 className="ci-spin h-4 w-4" />}
              {phase === 'opening' || renewing ? 'פותחים את התשלום…'
                : phase === 'paying' ? 'מבצעים את החיוב…'
                  : phase === 'verifying' ? 'מאמתים את התשלום…'
                    // The sum and the mode of the OPEN session — what a press charges.
                    : <>חיוב <span className="ci-num">{formatIlsAfter(card?.amount ?? amount ?? 0)}</span>{card?.test && ' · בדיקה'}</>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
