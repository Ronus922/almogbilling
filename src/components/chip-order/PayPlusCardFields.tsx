'use client';

// The card fields of /chip-order — PayPlus hosted fields (25/11/2026), drawn
// in the "אישור ותשלום" section exactly where the reference draws its inputs
// (ref/chip-order/chip-purchase-page-v2.html).
//
// The card number, the expiry and the CVV are PayPlus's own frames: this page
// never holds them. Each one is mounted into a box of ours (.cr-hf) that draws
// the field — background, border, radius, focus ring — and the frame inside
// carries only the typed text, styled through the SDK to match. The holder's
// name and ID number are our own inputs, which the SDK reads when it submits.
//
// THE SDK OWNS THIS MARKUP. It replaces our placeholders with frames, removes
// the wrapper of a field the payment page does not use, and writes into the
// inputs. So the block is a fixed HTML string React renders once and never
// diffs again; everything after that is done on the DOM directly, here and
// nowhere else.
//
// Two things the SDK (1.5.0) does not do, done here:
//   - its window message listener accepts a message from ANY origin, and on
//     "secure-3ds" appends a frame whose src it takes from the message. A
//     guard registered before it lets an SDK-shaped message through only from
//     the open session's own origin (see installMessageGuard), and a
//     "secure-3ds" src only when it is an https URL on a PayPlus host;
//   - an instance cannot be closed. Its listener is captured when it is made
//     and removed when a new payment session replaces it.
// What the SDK reports is never what makes an order paid — that is the
// server's, from PayPlus itself (the form asks /payplus/status).

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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
  SetHostedFieldsStyles(css: string): void;
  SetConfig(key: string, value: unknown): void;
  CreatePaymentPage(data: CardSession): Promise<void>;
  InitPaymentPage: { then(cb: (data: unknown) => void): void };
  SubmitPayment(): { then(cb: (data: unknown) => void): void };
}
declare global {
  interface Window {
    PayPlusHostedFieldsDom?: new () => HostedFieldsSdk;
  }
}

export type CardFieldsEvent =
  /** A charge is being submitted (true) / the submit ended (false). */
  | { type: 'busy'; value: boolean }
  /** The payment session can no longer be used. */
  | { type: 'dead'; why: 'expired' | 'attempts' }
  /** The card issuer's 3-D Secure window opened / closed. */
  | { type: 'secure3d'; open: boolean };

export interface CardFieldsHandle {
  /** Mounts the processor's fields for a payment session. Resolves when they
   *  are ready to type into; rejects when they could not be loaded. */
  open(session: CardSession, holderPhone: string): Promise<void>;
  /** Checks our own two fields and submits the charge. Resolves with the SDK's
   *  reply, `null` when our own check stopped it, or 'timeout'. */
  pay(): Promise<unknown>;
  /** Back to the idle look (nothing mounted). */
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

const INIT_TIMEOUT_MS = 25_000;
/** The first try, with the font in the style: the frames answer within a
 *  second or two; past this the page tries again without the font. */
const STYLED_INIT_TIMEOUT_MS = 12_000;
const SUBMIT_TIMEOUT_MS = 75_000;

const isPayPlusHost = (host: string) => host === 'payplus.co.il' || host.endsWith('.payplus.co.il');
const SECURE3DS_FRAME = 'iframe.hsted-Flds--r-secure3ds-iframe';
const SDK_MESSAGE_TYPES = new Set([
  'fld-validation', 'init', 'srv-response-msg', 'srv-response-result', 'cc-type', 'secure-3ds',
  'start-apple-pay', 'start-google-pay', 'recaptcha-token', 'recaptcha-challenge',
]);

/** The API origin of the payment session that is open now ('' = none): the
 *  only origin the SDK's own frames post from. */
let liveOrigin = '';
let guardInstalled = false;

/**
 * Registered BEFORE any SDK instance, so it runs first, and stops every
 * SDK-shaped message the SDK must not act on:
 *   - a typed message (init, a field's reply, the charge's result, …) counts
 *     only from the exact origin of the open session — the hosted-field frames;
 *   - "secure-3ds" tells the SDK to append a frame with a src taken from the
 *     message. It counts only when that src is absent or an https URL on a
 *     PayPlus host — never a javascript: / data: URL, never another site;
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

export const PayPlusCardFields = forwardRef<CardFieldsHandle, {
  /** Drawn but inert until a payment session is opened. */
  active: boolean;
  onEvent: (e: CardFieldsEvent) => void;
}>(function PayPlusCardFields({ active, onEvent }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  const live = useRef<{
    sdk: HostedFieldsSdk; detach: () => void; unlisten: () => void;
    /** When this session's page expires — a stale timer of an older instance fires earlier and is ignored. */
    expiresAt: number; secure3d: boolean;
  } | null>(null);

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
    if (!current) return;
    current.unlisten();
    current.detach();
    document.querySelectorAll('iframe.hsted-Flds--r-secure3ds-iframe').forEach((f) => f.remove());
  }

  function resetBlock() {
    if (!box.current) return;
    box.current.innerHTML = BLOCK_HTML;
    for (const id of ['pp-id', 'pp-name'] as const) {
      el<HTMLInputElement>(`#${id}`)?.addEventListener('input', () => showFieldError(id, null));
    }
    el<HTMLInputElement>('#pp-id')?.addEventListener('input', (e) => {
      const t = e.currentTarget as HTMLInputElement;
      t.value = t.value.replace(/\D/g, '').slice(0, 9);
    });
  }

  useEffect(() => {
    resetBlock();
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
      // A new session after an expired / exhausted one: what was typed into
      // our own two fields stays (the processor's frames start empty).
      const typed = { name: el<HTMLInputElement>('#pp-name')?.value ?? '', id: el<HTMLInputElement>('#pp-id')?.value ?? '' };
      const wide = window.matchMedia('(min-width: 621px)').matches;
      const styled = hostedFieldsCss(window.location.origin, wide, true);
      const plain = hostedFieldsCss(window.location.origin, wide, false);

      const mount = async (css: string, timeoutMs: number) => {
        closeLive();
        resetBlock();
        const nameInput = el<HTMLInputElement>('#pp-name');
        const idInput = el<HTMLInputElement>('#pp-id');
        if (nameInput) nameInput.value = typed.name;
        if (idInput) idInput.value = typed.id;
        installMessageGuard();
        liveOrigin = '';
        await loadSdk();
        if (!box.current) throw new Error('unmounted');
        const phone = el<HTMLInputElement>('#pp-phone');
        if (phone) phone.value = holderPhone;

        // The origin comes from OUR session route; anything but a PayPlus API host is refused here too.
        const sessionOrigin = new URL(session.origin);
        if (sessionOrigin.protocol !== 'https:' || !isPayPlusHost(sessionOrigin.hostname)) throw new Error('bad_origin');
        liveOrigin = sessionOrigin.origin;
        const { sdk, detach } = createSdk();
        const started = Date.now();
        const state = { sdk, detach, unlisten: () => {}, expiresAt: started + 30 * 60_000, secure3d: false };
        const handlers: [string, (e: Event) => void][] = [
          ['pp_submitProcess', (e) => { if (live.current === state) onEventRef.current({ type: 'busy', value: (e as CustomEvent).detail === true }); }],
          ['pp_noAttemptedRemaining', () => { if (live.current === state) onEventRef.current({ type: 'dead', why: 'attempts' }); }],
          ['pp_pageExpired', () => {
            // An older instance's timer cannot be cancelled; only this session's own expiry counts.
            if (live.current === state && Date.now() >= state.expiresAt - 5_000) onEventRef.current({ type: 'dead', why: 'expired' });
          }],
          ['pp_secure3dsWindow', (e) => {
            if (live.current !== state) return;
            state.secure3d = (e as CustomEvent).detail === true;
            onEventRef.current({ type: 'secure3d', open: state.secure3d });
          }],
        ];
        for (const [name, fn] of handlers) window.addEventListener(name, fn);
        state.unlisten = () => { for (const [name, fn] of handlers) window.removeEventListener(name, fn); };
        live.current = state;

        try {
          sdk.SetMainFields({
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
          sdk.SetHostedFieldsStyles(css);
          // The 3-D Secure window is laid out by our own stylesheet (it must fit a phone).
          sdk.SetConfig('Secure3Ds.ResetStyle', true);

          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('sdk_timeout')), timeoutMs);
            sdk.InitPaymentPage.then((data) => {
              const minutes = Number((data as { data?: { page_expiration_time?: unknown } } | null)?.data?.page_expiration_time);
              if (Number.isFinite(minutes) && minutes > 0) state.expiresAt = started + minutes * 60_000;
              // The SDK builds the rest of its frames in its own callback, which runs after this one.
              window.setTimeout(() => { window.clearTimeout(timer); resolve(); }, 0);
            });
            sdk.CreatePaymentPage(session).catch((e: unknown) => { window.clearTimeout(timer); reject(e instanceof Error ? e : new Error('sdk_failed')); });
          });
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
      if (!state) return null;
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
      return new Promise<unknown>((resolve) => {
        let settled = false;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          window.clearInterval(watch);
          resolve(value);
        };
        // No answer at all → the form asks the server what really happened.
        // The clock does not run while the issuer's 3-D Secure window is open.
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
    <div
      ref={box}
      className="cr-ppbox"
      data-state={active ? 'active' : 'idle'}
      data-testid="chip-order-card-hosted"
      // Fixed markup, rendered once — see the header: the SDK owns it.
      dangerouslySetInnerHTML={{ __html: BLOCK_HTML }}
    />
  );
});
