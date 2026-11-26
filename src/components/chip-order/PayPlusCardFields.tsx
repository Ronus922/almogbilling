'use client';

// The payment fields of /chip-order — PayPlus hosted fields (25/11/2026), drawn
// in the "אישור ותשלום" section exactly where the reference draws its inputs
// (ref/chip-order/chip-purchase-page-v2.html), with the wallet buttons (Google
// Pay / Apple Pay, 26/11/2026) above them.
//
// The card number, the expiry and the CVV are PayPlus's own frames: this page
// never holds them. Each one is mounted into a box of ours (.cr-hf) that draws
// the field — background, border, radius, focus ring — and the frame inside
// carries only the typed text, styled through the SDK to match. The holder's
// name and ID number are our own inputs, which the SDK reads when it submits.
// The wallet buttons are PayPlus frames too (48px, full width): the SDK puts
// one in place of a placeholder of ours only when the payment page offers that
// wallet and — for Apple Pay — the device can pay with it.
//
// THE SDK OWNS THIS MARKUP. It replaces our placeholders with frames, removes
// the wrapper of a field the payment page does not use, and writes into the
// inputs. So the card block and the wallet placeholders are fixed HTML strings
// React renders once and never diffs again; everything after that is done on
// the DOM directly, here and nowhere else.
//
// Things the SDK (1.5.0) does not do, done here:
//   - its window message listener accepts a message from ANY origin, and on
//     "secure-3ds" appends a frame whose src it takes from the message. A
//     guard registered before it lets an SDK-shaped message through only from
//     the open session's own origin (see installMessageGuard), a "secure-3ds"
//     src only when it is an https URL on a PayPlus host, and a wallet start
//     only while the form says the wallets may charge;
//   - an instance cannot be closed. Its listener is captured when it is made
//     and removed when a new payment session replaces it;
//   - a wallet click charges at once, with no hook before it. The row is
//     `inert` (and covered by a button of ours) until the form arms it, and
//     the wallet's result — a window event only — is handed to the form like
//     a card result; no result in 3 minutes → the form asks the server;
//   - the issuer's 3-D Secure frame is closed only on its own result, so a
//     frame that never reports (it did not load, or the issuer's page is one
//     our frame-src refuses) would stay over the page for good. It is closed
//     here after SECURE3D_TIMEOUT_MS, and a charge waiting for it ends as
//     'timeout' — the form asks the server (see secure3dWindow).
// What the SDK reports is never what makes an order paid — that is the
// server's, from PayPlus itself (the form asks /payplus/status).

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CARD_TEXT, hostedFieldsCss, isValidIsraeliId, type CardSession } from '@/lib/chipOrders/card';

/** The part of the SDK this component uses (payplus-hosted-fields 1.5.0). */
interface FieldTarget {
  elmSelector: string;
  wrapperElmSelector: string;
  config?: { placeholder?: string; fontName?: string };
}
interface HostedFieldsSdk {
  SetMainFields(fields: Record<'cc' | 'cvv' | 'expiry' | 'expiryy' | 'expirym', FieldTarget>): HostedFieldsSdk;
  AddField(name: string, elmSelector: string, wrapperElmSelector?: string): HostedFieldsSdk;
  SetRecaptcha(elmSelector: string): HostedFieldsSdk;
  /** The element must exist when called; the SDK replaces it with the wallet's frame. */
  SetApplePay(elmSelector: string): HostedFieldsSdk;
  SetGooglePay(elmSelector: string): HostedFieldsSdk;
  SetHostedFieldsStyles(css: string): void;
  SetConfig(key: string, value: unknown): void;
  CreatePaymentPage(data: CardSession): Promise<void>;
  InitPaymentPage: { then(cb: (data: unknown) => void): void };
  SubmitPayment(): { then(cb: (data: unknown) => void): void };
  /** Throws before the page data arrived. */
  GetRemainingAttempts(): number;
}
declare global {
  interface Window {
    PayPlusHostedFieldsDom?: new () => HostedFieldsSdk;
  }
}

export type CardFieldsEvent =
  /** The payment session can no longer be used. */
  | { type: 'dead'; why: 'expired' | 'attempts' }
  /** The card issuer's 3-D Secure window opened / closed (by the SDK, or
   *  here when it reported nothing in SECURE3D_TIMEOUT_MS). */
  | { type: 'secure3d'; open: boolean }
  /** A wallet button started a charge (the SDK offers no hook before it). */
  | { type: 'wallet-start' }
  /** What a wallet charge ended with — the SDK's object, or 'timeout' when
   *  nothing came back in time. Also a card result that arrived after pay()
   *  had given up on it. */
  | { type: 'wallet-result'; reply: unknown };

export interface CardFieldsHandle {
  /** Mounts the processor's fields (and the wallet buttons the payment page
   *  offers) for a payment session. Resolves when they are ready to type
   *  into; rejects when they could not be loaded. */
  open(session: CardSession, holderPhone: string): Promise<void>;
  /** Checks our own two fields and submits the charge. Resolves with the SDK's
   *  reply, `null` when our own check stopped it, or 'timeout'. */
  pay(): Promise<unknown>;
  /** Back to the idle look (nothing mounted). What was typed into our own
   *  two fields (the holder's name and ID) stays for the next open. */
  close(): void;
}

// The block, as the reference draws it: card number + holder ID, then holder
// name + expiry + CVV. Both expiry layouts are present — the SDK keeps the one
// the payment page is configured for and removes the other.
const CARD_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path></svg>';
const REQ = '<span class="cr-req">*</span>';
const BLOCK_HTML = [
  '<div class="cr-frow cr-pp-row1">',
  `<div class="cr-fld cr-cardfld" id="pp-cc-wrap"><span class="cr-lbl">מספר כרטיס ${REQ}</span>${CARD_ICON}`,
  '<div class="cr-hf"><span id="pp-cc" class="cr-hf-ph">0000 0000 0000 0000</span></div></div>',
  `<div class="cr-fld" id="pp-id-wrap"><label for="pp-id">ת&quot;ז בעל הכרטיס ${REQ}</label>`,
  '<input id="pp-id" type="text" inputmode="numeric" autocomplete="off" placeholder="9 ספרות" maxlength="9" class="cr-num cr-ltr" disabled>',
  '<span class="cr-err" data-err="pp-id" hidden></span></div>',
  '</div>',
  '<div class="cr-paygrid cr-pp-row2">',
  `<div class="cr-fld" id="pp-name-wrap"><label for="pp-name">שם בעל הכרטיס ${REQ}</label>`,
  '<input id="pp-name" type="text" autocomplete="cc-name" placeholder="כפי שמופיע על הכרטיס" maxlength="60" disabled>',
  '<span class="cr-err" data-err="pp-name" hidden></span></div>',
  `<div class="cr-fld" id="pp-expiry-wrap"><span class="cr-lbl">תוקף ${REQ}</span>`,
  '<div class="cr-hf"><span id="pp-expiry" class="cr-hf-ph">MM/YY</span></div></div>',
  `<div class="cr-fld" id="pp-expiry-split-wrap"><span class="cr-lbl">תוקף ${REQ}</span><div class="cr-hf-split">`,
  '<div class="cr-hf"><span id="pp-expirym" class="cr-hf-ph">MM</span></div>',
  '<div class="cr-hf"><span id="pp-expiryy" class="cr-hf-ph">YY</span></div></div></div>',
  `<div class="cr-fld" id="pp-cvv-wrap"><span class="cr-lbl">CVV ${REQ}</span>`,
  '<div class="cr-hf"><span id="pp-cvv" class="cr-hf-ph">•••</span></div></div>',
  '</div>',
  // 3-D Secure needs the holder's phone; it is the order's own, never typed again.
  '<span id="pp-phone-wrap" hidden><input id="pp-phone" type="hidden"></span>',
  // Replaced by the processor's "I'm not a robot" frame when its page asks for one.
  '<div class="cr-pp-recaptcha"><span id="pp-recaptcha"></span></div>',
].join('');
// Each is replaced by that wallet's frame when it is offered; one that is not
// offered stays an empty, hidden placeholder.
const WALLET_HTML = '<span id="pp-googlepay"></span><span id="pp-applepay"></span>';
const BLOCK_INNER = { __html: BLOCK_HTML };
const WALLET_INNER = { __html: WALLET_HTML };
const GOOGLE_PAY_FRAME = 'hsted-Flds--google-pay-iframe';
const APPLE_PAY_FRAME = 'hsted-Flds--apple-pay-iframe';

const INIT_TIMEOUT_MS = 25_000;
/** The first try, with the font in the style: the frames answer within a
 *  second or two; past this the page tries again without the font. */
const STYLED_INIT_TIMEOUT_MS = 12_000;
const SUBMIT_TIMEOUT_MS = 45_000;
/** A wallet charge with no result this long → the form asks the server. */
const WALLET_WATCHDOG_MS = 3 * 60_000;
/** An issuer's 3-D Secure window open this long with no result is closed
 *  here (a real challenge — a code by SMS, an app approval — takes minutes). */
const SECURE3D_TIMEOUT_MS = 10 * 60_000;

const isPayPlusHost = (host: string) => host === 'payplus.co.il' || host.endsWith('.payplus.co.il');
const SECURE3DS_FRAME = 'iframe.hsted-Flds--r-secure3ds-iframe';
const SDK_MESSAGE_TYPES = new Set([
  'fld-validation', 'init', 'srv-response-msg', 'srv-response-result', 'cc-type', 'secure-3ds',
  'start-apple-pay', 'start-google-pay', 'recaptcha-token', 'recaptcha-challenge',
]);
const WALLET_START_TYPES = new Set(['start-apple-pay', 'start-google-pay']);

/** The API origin of the payment session that is open now ('' = none): the
 *  only origin the SDK's own frames post from. */
let liveOrigin = '';
/** The form armed the wallet buttons and no card charge is in flight. */
let walletsOpen = false;
let guardInstalled = false;

/**
 * Registered BEFORE any SDK instance, so it runs first, and stops every
 * SDK-shaped message the SDK must not act on:
 *   - a typed message (init, a field's reply, the charge's result, …) counts
 *     only from the exact origin of the open session — the hosted-field frames;
 *   - "secure-3ds" tells the SDK to append a frame with a src taken from the
 *     message. It counts only when that src is absent or an https URL on a
 *     PayPlus host — never a javascript: / data: URL, never another site;
 *   - a wallet start ("start-apple-pay" / "start-google-pay") charges at once:
 *     it counts only while the form armed the wallets (its row is inert
 *     otherwise) and no card charge is in flight — card and wallet never run
 *     together;
 *   - the result of 3-D Secure (messageTransaction3DS) counts from a PayPlus
 *     origin, or from the 3-D Secure frame the SDK itself opened.
 * Everything else never reaches the SDK's listener.
 */
function installMessageGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    const d: unknown = ev.data;
    if (!d || typeof d !== 'object') return;
    const m = d as { type?: unknown; data?: unknown; messageTransaction3DS?: unknown };
    const typed = typeof m.type === 'string' && SDK_MESSAGE_TYPES.has(m.type);
    const secure3dResult = !typed && m.messageTransaction3DS != null;
    if (!typed && !secure3dResult) return; // not the SDK's business
    let allowed = false;
    if (typed) {
      allowed = liveOrigin !== '' && ev.origin === liveOrigin;
      if (allowed && WALLET_START_TYPES.has(m.type as string)) allowed = walletsOpen;
      if (allowed && m.type === 'secure-3ds' && m.data != null) {
        allowed = false;
        if (typeof m.data === 'string') {
          try {
            const target = new URL(m.data);
            allowed = target.protocol === 'https:' && isPayPlusHost(target.hostname);
          } catch {
            allowed = false;
          }
        }
      }
    } else {
      let fromPayPlus = false;
      try {
        const from = new URL(ev.origin);
        fromPayPlus = from.protocol === 'https:' && isPayPlusHost(from.hostname);
      } catch {
        fromPayPlus = false;
      }
      const frame = document.querySelector<HTMLIFrameElement>(SECURE3DS_FRAME);
      allowed = liveOrigin !== '' && (fromPayPlus || (frame?.contentWindow != null && frame.contentWindow === ev.source));
    }
    if (!allowed) ev.stopImmediatePropagation();
  }, true);
}

let sdkLoading: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (window.PayPlusHostedFieldsDom) return Promise.resolve();
  // The package's browser bundle: it defines window.PayPlusHostedFieldsDom.
  sdkLoading ??= import('payplus-hosted-fields/dist/payplus-hosted-fields.min.js').then(() => {
    if (!window.PayPlusHostedFieldsDom) throw new Error('sdk_missing');
  });
  sdkLoading.catch(() => { sdkLoading = null; });
  return sdkLoading;
}

/** A new SDK instance, with the window listeners it registers while it is
 *  being made — so that it can be detached later (the SDK has no "destroy").
 *  For the length of the constructor call only, window.addEventListener is
 *  shadowed by a recorder that passes every call on; whatever stood there
 *  before is put back exactly. */
function createSdk(): { sdk: HostedFieldsSdk; detach: () => void } {
  const Ctor = window.PayPlusHostedFieldsDom;
  if (!Ctor) throw new Error('sdk_missing');
  type Options = boolean | AddEventListenerOptions | undefined;
  const captured: [string, EventListenerOrEventListenerObject, Options][] = [];
  const before = Object.getOwnPropertyDescriptor(window, 'addEventListener');
  Object.defineProperty(window, 'addEventListener', {
    configurable: true,
    writable: true,
    value(type: string, listener: EventListenerOrEventListenerObject, options?: Options) {
      captured.push([type, listener, options]);
      EventTarget.prototype.addEventListener.call(window, type, listener, options);
    },
  });
  let sdk: HostedFieldsSdk;
  try {
    sdk = new Ctor();
  } finally {
    if (before) Object.defineProperty(window, 'addEventListener', before);
    else Reflect.deleteProperty(window, 'addEventListener');
  }
  return {
    sdk,
    detach: () => { for (const [type, listener, options] of captured) window.removeEventListener(type, listener, options); },
  };
}

interface LiveState {
  sdk: HostedFieldsSdk;
  detach: () => void;
  unlisten: () => void;
  /** When this session's page expires — a stale timer of an older instance fires earlier and is ignored. */
  expiresAt: number;
  secure3d: boolean;
  /** Closes the 3-D Secure window when it reported nothing in time. */
  secure3dTimer: number | null;
  /** pay() is waiting for the SDK's answer: a result event belongs to it. */
  cardSubmitting: boolean;
  /** Ends that wait with 'timeout' (set by pay() while it waits). */
  endSubmit: (() => void) | null;
  /** A wallet button started a charge and its result has not come yet. */
  walletFlow: boolean;
  walletTimer: number | null;
}

interface Wallets { google: boolean; apple: boolean }
const NO_WALLETS: Wallets = { google: false, apple: false };

export const PayPlusCardFields = forwardRef<CardFieldsHandle, {
  /** A payment session is open: the fields are live. Drawn but inert otherwise. */
  active: boolean;
  onEvent: (e: CardFieldsEvent) => void;
  /** The wallet buttons (Google Pay / Apple Pay) — the public order page.
   *  Without this none are asked for. */
  wallets?: {
    /** They may charge now (the form is complete, saved and agreed, and
     *  nothing is being paid). Otherwise their row is inert. */
    armed: boolean;
    /** A tap on the wallet row while it is not armed. */
    onGate: () => void;
  };
}>(function PayPlusCardFields({ active, onEvent, wallets }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const walletBox = useRef<HTMLDivElement>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  const walletsArmed = wallets?.armed ?? false;
  const armedRef = useRef(walletsArmed);
  const live = useRef<LiveState | null>(null);
  /** The holder's ID and name as last typed — kept across every reset of the block. */
  const typed = useRef({ 'pp-id': '', 'pp-name': '' });
  const [shown, setWallets] = useState<Wallets>(NO_WALLETS);
  const anyWallet = shown.google || shown.apple;

  useEffect(() => {
    armedRef.current = walletsArmed;
    walletsOpen = walletsArmed && !(live.current?.cardSubmitting ?? false);
  }, [walletsArmed]);

  const el = <T extends HTMLElement>(selector: string) => box.current?.querySelector<T>(selector) ?? null;

  function showFieldError(id: 'pp-id' | 'pp-name', message: string | null) {
    const input = el<HTMLInputElement>(`#${id}`);
    const line = el<HTMLSpanElement>(`[data-err="${id}"]`);
    input?.classList.toggle('cr-bad', Boolean(message));
    if (line) {
      line.textContent = message ?? '';
      line.hidden = !message;
    }
  }

  function closeLive() {
    const current = live.current;
    live.current = null;
    liveOrigin = '';
    walletsOpen = false;
    if (!current) return;
    if (current.walletTimer !== null) window.clearTimeout(current.walletTimer);
    if (current.secure3dTimer !== null) window.clearTimeout(current.secure3dTimer);
    current.unlisten();
    current.detach();
    document.querySelectorAll(SECURE3DS_FRAME).forEach((f) => f.remove());
  }

  /** The placeholders again, as first drawn (the SDK replaced them). What was
   *  typed into our own two fields stays — a new session (expired, out of
   *  attempts) or one that failed to open does not make the customer type the
   *  holder's name and ID again; only the processor's frames start empty. A
   *  field the SDK removed keeps what it held before. */
  function resetDom() {
    if (walletBox.current) walletBox.current.innerHTML = WALLET_HTML;
    if (!box.current) return;
    for (const id of ['pp-id', 'pp-name'] as const) {
      const input = el<HTMLInputElement>(`#${id}`);
      if (input) typed.current[id] = input.value;
    }
    box.current.innerHTML = BLOCK_HTML;
    for (const id of ['pp-id', 'pp-name'] as const) {
      const input = el<HTMLInputElement>(`#${id}`);
      if (!input) continue;
      input.value = typed.current[id];
      input.addEventListener('input', () => showFieldError(id, null));
    }
    el<HTMLInputElement>('#pp-id')?.addEventListener('input', (e) => {
      const t = e.currentTarget as HTMLInputElement;
      t.value = t.value.replace(/\D/g, '').slice(0, 9);
    });
  }

  function resetBlock() {
    resetDom();
    setWallets(NO_WALLETS);
  }

  /** The SDK disables its frames when a wallet charge starts and enables them
   *  again only on that charge's result. When none came, they are enabled
   *  here the same way (the message the SDK itself sends them). */
  function enableFrames() {
    box.current?.querySelectorAll<HTMLIFrameElement>('iframe.__payplus_hosted_fields_item_fld-frame').forEach((f) => {
      f.classList.remove('__payplus_hosted_field_disabled');
      if (liveOrigin) f.contentWindow?.postMessage({ type: 'toggle-disable-form', data: true }, liveOrigin);
    });
  }

  /** The issuer's 3-D Secure window opened or closed. Open, it has a time
   *  limit: the SDK removes its frame only on that frame's own result, so a
   *  frame that never reports would cover the page (under the form's
   *  backdrop) until a reload. Past SECURE3D_TIMEOUT_MS the frame is removed
   *  here, the form hears "closed", and a charge waiting for it ends as
   *  'timeout' — the form asks the server what happened, and offers a new
   *  charge only when PayPlus ruled one out. */
  function secure3dWindow(state: LiveState, open: boolean) {
    state.secure3d = open;
    if (state.secure3dTimer !== null) window.clearTimeout(state.secure3dTimer);
    state.secure3dTimer = !open ? null : window.setTimeout(() => {
      if (live.current !== state || !state.secure3d) return;
      document.querySelectorAll(SECURE3DS_FRAME).forEach((f) => f.remove());
      secure3dWindow(state, false);
      state.endSubmit?.();
    }, SECURE3D_TIMEOUT_MS);
    onEventRef.current({ type: 'secure3d', open });
  }

  useEffect(() => {
    resetDom();
    return () => closeLive();
    // Mounted once: the block belongs to the SDK from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The focus ring of a processor frame. Focus inside a frame is invisible to
  // this page's CSS (:focus-within does not see it) and fires no event here
  // when it moves from one frame to the next — only window "blur" when it
  // first leaves the page. So: while the active element is one of the frames,
  // look every 150ms which one, and mark its box; stop when focus comes back.
  useEffect(() => {
    let timer: number | null = null;
    const sync = () => {
      const active = document.activeElement;
      const inside = active instanceof HTMLIFrameElement && box.current?.contains(active) ? active.closest('.cr-hf') : null;
      box.current?.querySelectorAll('.cr-hf.cr-hf-focus').forEach((b) => { if (b !== inside) b.classList.remove('cr-hf-focus'); });
      inside?.classList.add('cr-hf-focus');
      if (!inside && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      return inside !== null;
    };
    const onBlur = () => {
      // The active element is updated just after the event.
      window.setTimeout(() => { if (sync() && timer === null) timer = window.setInterval(sync, 150); }, 0);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', sync);
    document.addEventListener('focusin', sync);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', sync);
      document.removeEventListener('focusin', sync);
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    async open(session, holderPhone) {
      const withWallets = wallets !== undefined;
      const wide = window.matchMedia('(min-width: 621px)').matches;
      const styled = hostedFieldsCss(window.location.origin, wide, true);
      const plain = hostedFieldsCss(window.location.origin, wide, false);

      const mount = async (css: string, timeoutMs: number) => {
        closeLive();
        // The holder's name and ID typed so far stay (resetDom).
        resetBlock();
        installMessageGuard();
        liveOrigin = '';
        await loadSdk();
        if (!box.current || (withWallets && !walletBox.current)) throw new Error('unmounted');
        const phone = el<HTMLInputElement>('#pp-phone');
        if (phone) phone.value = holderPhone;

        // The origin comes from OUR session route; anything but a PayPlus API host is refused here too.
        const sessionOrigin = new URL(session.origin);
        if (sessionOrigin.protocol !== 'https:' || !isPayPlusHost(sessionOrigin.hostname)) throw new Error('bad_origin');
        liveOrigin = sessionOrigin.origin;
        const { sdk, detach } = createSdk();
        const started = Date.now();
        const state: LiveState = {
          sdk, detach, unlisten: () => {}, expiresAt: started + 30 * 60_000, secure3d: false, secure3dTimer: null,
          cardSubmitting: false, endSubmit: null, walletFlow: false, walletTimer: null,
        };
        const endWallet = () => {
          state.walletFlow = false;
          if (state.walletTimer !== null) window.clearTimeout(state.walletTimer);
          state.walletTimer = null;
        };
        const handlers: [string, (e: Event) => void][] = [
          ['pp_submitProcess', (e) => {
            // `true` without our pay(): a wallet button started a charge.
            if (live.current !== state || (e as CustomEvent).detail !== true || state.cardSubmitting || state.walletFlow) return;
            state.walletFlow = true;
            state.walletTimer = window.setTimeout(() => {
              if (live.current !== state || !state.walletFlow) return;
              endWallet();
              enableFrames();
              onEventRef.current({ type: 'wallet-result', reply: 'timeout' });
            }, WALLET_WATCHDOG_MS);
            onEventRef.current({ type: 'wallet-start' });
          }],
          ['pp_responseFromServer', (e) => {
            // A card result reaches pay() through its own promise.
            if (live.current !== state || state.cardSubmitting) return;
            endWallet();
            onEventRef.current({ type: 'wallet-result', reply: (e as CustomEvent).detail });
          }],
          ['pp_noAttemptedRemaining', () => { if (live.current === state) onEventRef.current({ type: 'dead', why: 'attempts' }); }],
          ['pp_pageExpired', () => {
            // An older instance's timer cannot be cancelled; only this session's own expiry counts.
            if (live.current === state && Date.now() >= state.expiresAt - 5_000) onEventRef.current({ type: 'dead', why: 'expired' });
          }],
          ['pp_secure3dsWindow', (e) => {
            if (live.current === state) secure3dWindow(state, (e as CustomEvent).detail === true);
          }],
        ];
        for (const [name, fn] of handlers) window.addEventListener(name, fn);
        state.unlisten = () => { for (const [name, fn] of handlers) window.removeEventListener(name, fn); };
        live.current = state;
        walletsOpen = armedRef.current;

        try {
          const fields = sdk.SetMainFields({
            cc: { elmSelector: '#pp-cc', wrapperElmSelector: '#pp-cc-wrap', config: { placeholder: '0000 0000 0000 0000' } },
            expiry: { elmSelector: '#pp-expiry', wrapperElmSelector: '#pp-expiry-wrap', config: { placeholder: 'MM/YY' } },
            expirym: { elmSelector: '#pp-expirym', wrapperElmSelector: '#pp-expiry-split-wrap', config: { placeholder: 'MM' } },
            expiryy: { elmSelector: '#pp-expiryy', wrapperElmSelector: '#pp-expiry-split-wrap', config: { placeholder: 'YY' } },
            cvv: { elmSelector: '#pp-cvv', wrapperElmSelector: '#pp-cvv-wrap', config: { placeholder: '•••' } },
          })
            .AddField('card_holder_id', '#pp-id', '#pp-id-wrap')
            .AddField('card_holder_name', '#pp-name', '#pp-name-wrap')
            .AddField('card_holder_phone', '#pp-phone', '#pp-phone-wrap')
            .SetRecaptcha('#pp-recaptcha');
          // The placeholders exist now (the SDK keeps the elements, not the selectors).
          if (withWallets) fields.SetGooglePay('#pp-googlepay').SetApplePay('#pp-applepay');
          sdk.SetHostedFieldsStyles(css);
          // The 3-D Secure window is laid out by our own stylesheet (it must fit a phone).
          sdk.SetConfig('Secure3Ds.ResetStyle', true);

          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('sdk_timeout')), timeoutMs);
            // Registered BEFORE CreatePaymentPage: the SDK runs these callbacks
            // last-in first-out, so its own — which builds the card, reCAPTCHA
            // and wallet frames — runs before this one.
            sdk.InitPaymentPage.then((data) => {
              const minutes = Number((data as { data?: { page_expiration_time?: unknown } } | null)?.data?.page_expiration_time);
              if (Number.isFinite(minutes) && minutes > 0) state.expiresAt = started + minutes * 60_000;
              window.setTimeout(() => { window.clearTimeout(timer); resolve(); }, 0);
            });
            sdk.CreatePaymentPage(session).catch((e: unknown) => { window.clearTimeout(timer); reject(e instanceof Error ? e : new Error('sdk_failed')); });
          });
          // A wallet's frame exists only when the payment page offers it (and,
          // for Apple Pay, the device can pay with it).
          setWallets({ google: document.getElementById(GOOGLE_PAY_FRAME) !== null, apple: document.getElementById(APPLE_PAY_FRAME) !== null });
        } catch (e) {
          if (live.current === state) closeLive();
          resetBlock();
          throw e;
        }
      };

      if (styled === plain) {
        await mount(plain, INIT_TIMEOUT_MS);
      } else {
        try {
          await mount(styled, STYLED_INIT_TIMEOUT_MS);
        } catch (e) {
          // The frames did not come up. One cause is ours to rule out: the
          // style travels in each frame's address, and with the font it holds
          // a URL — a filter in front of the processor may refuse an address
          // like that (it refuses one that names localhost). Once more,
          // without the font: the digits then show in the fallback family.
          if (!(e instanceof Error) || e.message !== 'sdk_timeout' || !box.current) throw e;
          await mount(plain, INIT_TIMEOUT_MS);
        }
      }
      for (const id of ['pp-id', 'pp-name'] as const) {
        const input = el<HTMLInputElement>(`#${id}`);
        if (input) input.disabled = false;
      }
    },

    async pay() {
      const state = live.current;
      // Card and wallet never run together.
      if (!state || state.walletFlow) return null;
      // Our own two fields (each may have been removed by the SDK when the
      // payment page does not ask for it).
      const name = el<HTMLInputElement>('#pp-name');
      const id = el<HTMLInputElement>('#pp-id');
      let bad: HTMLInputElement | null = null;
      if (name && name.value.trim().length < 2) { showFieldError('pp-name', CARD_TEXT.nameRequired); bad ??= name; }
      if (id && !isValidIsraeliId(id.value)) { showFieldError('pp-id', CARD_TEXT.idInvalid); bad ??= id; }
      if (bad) {
        bad.focus();
        return null;
      }
      state.cardSubmitting = true;
      walletsOpen = false;
      return new Promise<unknown>((resolve) => {
        let settled = false;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          window.clearInterval(watch);
          state.cardSubmitting = false;
          state.endSubmit = null;
          if (live.current === state) walletsOpen = armedRef.current;
          resolve(value);
        };
        state.endSubmit = () => finish('timeout');
        // No answer at all → the form asks the server what really happened.
        // The clock does not run while the issuer's 3-D Secure window is open
        // (that window has a limit of its own: secure3dWindow ends this wait).
        let waited = 0;
        const watch = window.setInterval(() => {
          if (live.current !== state) return finish('timeout');
          if (!state.secure3d) waited += 1_000;
          if (waited >= SUBMIT_TIMEOUT_MS) finish('timeout');
        }, 1_000);
        try {
          state.sdk.SubmitPayment().then(finish);
        } catch {
          finish('timeout');
        }
      });
    },

    close() {
      closeLive();
      resetBlock();
    },
  }));

  return (
    <div className="cr-ppbox" data-state={active ? 'active' : 'idle'} data-testid="chip-order-card-hosted">
      {/* The wallet buttons: shown only when the payment page offers one.
          Not armed = inert and dimmed, under a transparent button of ours
          (a sibling — inside the inert row it would be inert too). */}
      {wallets && (
        <div className="cr-wallets-row" data-testid="chip-order-wallets" hidden={!anyWallet}>
          <div
            ref={walletBox}
            className="cr-wallets"
            inert={!walletsArmed}
            aria-disabled={walletsArmed ? undefined : true}
            // Fixed markup, rendered once — see the header: the SDK owns it.
            dangerouslySetInnerHTML={WALLET_INNER}
          />
          {!walletsArmed && (
            <button type="button" className="cr-wallet-gate" aria-label={CARD_TEXT.walletGate} onClick={wallets.onGate} />
          )}
        </div>
      )}
      {anyWallet && <p className="cr-walletsep"><span>{CARD_TEXT.walletDivider}</span></p>}
      {/* Fixed markup, rendered once — see the header: the SDK owns it. */}
      <div ref={box} dangerouslySetInnerHTML={BLOCK_INNER} />
    </div>
  );
});
