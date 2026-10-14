'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { PortalTab } from '@/lib/portal/ui';
import {
  DecisionsIcon, DockAccountIcon, DockBalanceIcon, DockFundIcon, DockHomeIcon,
  DockPlusIcon, DockProtocolIcon, DockTrendIcon, DockWrenchIcon,
} from './PortalIcons';

// Floating bottom dock — the mobile portal's nav, replacing the top tab row
// at ≤600px (portal.css; DESIGN.md's own mobile breakpoint, not the
// reference's assumed 767px). 1:1 from ref/mobile-bottom-nav
// (Mobile Bottom Nav.html + .md), a DECLARED EXCEPTION like the rest of the
// portal: colours, radii, spacing and every animation (the FAB's 45°
// rotation, the quick menu's staggered spring entrance) are the reference's
// own. Round 2 (14/10/2026) added touch magnification and the tap
// press-bounce below — the reference explicitly disables magnify on touch;
// see DESIGN.md for the declared deviation and why (Ronen: "the animation
// doesn't work" on Android was this deliberate mouse-only gate, not a bug).
//
// "החלטות" and "פרוטוקולים" are two quick-action BUTTONS over ONE unified tab
// (`?tab=dec`, the list the dec tab has shown both types in since 05/10/2026
// — DESIGN.md's declared exception: no type selector) — the dock does not
// reopen that decision, it just opens the tab pre-filtered to the chip the
// button stands for (round 2, 14/10/2026: `?tab=dec&type=decision|protocol`,
// PortalDecisions' own chips). The reference itself anticipated exactly this
// split ("פרוטוקולים הוכנס לתפריט הפעולות — לא יעד ניווט יומיומי").
// "מאזנים" is the one genuinely new destination (`?tab=bal`), no chip.
//
// Magnification is ported verbatim from the reference's vanilla-JS loop
// (kaif-ui style: items grow in SIZE, not transform, so neighbours are
// pushed apart) — a lerp-eased requestAnimationFrame loop writing directly
// to each button's style.width/height via refs, never through React state
// (state churn at 60fps would fight the spring feel). Round 2: the SAME loop
// now also tracks a finger (touchstart/touchmove), not only a mouse — one
// `pointerX`, two input sources.
//
// This dock also mounts on /portal/report (round 2) — the fault-report
// screen, previously without it — with `tab={null}`: no dock item is "on"
// there, since it isn't any of the six tabs.

const GROW = 24;
const RANGE = 100;
/** The tap press-bounce's release duration (portal-dock.css) — navigation
 *  waits for it, so the spring is seen before the screen changes. */
const TAP_RELEASE_MS = 300;
/** Finger movement beyond this, between touchstart and touchend, is a swipe
 *  (exploring magnification), never a tap — no bounce, no navigation. */
const SWIPE_THRESHOLD = 10;

export function PortalMobileDock({ tab, onNavigate, preview }: {
  /** null on /portal/report — not any of the six tabs, so nothing is "on". */
  tab: PortalTab | null;
  /** `type` is the dec tab's chip ("decision" | "protocol") — only "החלטות"
   *  and "פרוטוקולים" below pass one, so the dec tab opens pre-filtered
   *  instead of always landing on "הכל". */
  onNavigate: (next: PortalTab, type?: 'decision' | 'protocol') => void;
  /** The admin preview (/finance?view=resident): no portal session, so the
   *  fault-report quick action is dropped — the same gate PortalShell's own
   *  top-of-content "דיווח על תקלה" button already uses. */
  preview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // One named ref per dock button (not a dynamically-indexed array of ref
  // callbacks — react-hooks/refs flags a callback factory built in render).
  const ovRef = useRef<HTMLButtonElement>(null);
  const txRef = useRef<HTMLButtonElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const fundRef = useRef<HTMLButtonElement>(null);
  const accRef = useRef<HTMLButtonElement>(null);

  // The reference's magnification loop, translated to refs: direct DOM writes
  // on every frame, state untouched. Mouse AND touch feed the same `pointerX`
  // — a finger dragged across the dock grows items exactly like a cursor
  // does (round 2); neither ever reaches this effect's own re-run, so it
  // mounts once.
  useEffect(() => {
    const dockEl = dockRef.current;
    if (!dockEl) return undefined;

    const items: Array<{ el: HTMLButtonElement | null; base: number; cur: number; tgt: number }> = [
      { el: ovRef.current, base: 40, cur: 40, tgt: 40 },
      { el: txRef.current, base: 40, cur: 40, tgt: 40 },
      { el: fabRef.current, base: 46, cur: 46, tgt: 46 },
      { el: fundRef.current, base: 40, cur: 40, tgt: 40 },
      { el: accRef.current, base: 40, cur: 40, tgt: 40 },
    ];
    let pointerX = Infinity;
    let raf: number | null = null;

    function tick() {
      let live = false;
      for (const o of items) {
        if (!o.el) continue;
        o.cur += (o.tgt - o.cur) * 0.25;
        if (Math.abs(o.tgt - o.cur) > 0.1) live = true;
        else o.cur = o.tgt;
        const size = o.cur === o.base ? '' : `${o.cur}px`;
        o.el.style.width = size;
        o.el.style.height = size;
      }
      raf = live ? requestAnimationFrame(tick) : null;
    }

    function setTargets() {
      for (const o of items) {
        if (!o.el || pointerX === Infinity) { o.tgt = o.base; continue; }
        const r = o.el.getBoundingClientRect();
        const d = Math.abs(pointerX - (r.left + r.width / 2));
        const f = Math.max(0, 1 - d / RANGE);
        o.tgt = o.base + GROW * f * f;
      }
      if (raf === null) raf = requestAnimationFrame(tick);
    }

    const onMouseMove = (e: MouseEvent) => { pointerX = e.clientX; setTargets(); };
    const onMouseLeave = () => { pointerX = Infinity; setTargets(); };
    const onTouchStart = (e: TouchEvent) => { pointerX = e.touches[0]?.clientX ?? Infinity; setTargets(); };
    const onTouchMove = (e: TouchEvent) => { pointerX = e.touches[0]?.clientX ?? Infinity; setTargets(); };
    const onTouchEnd = () => { pointerX = Infinity; setTargets(); };
    dockEl.addEventListener('mousemove', onMouseMove);
    dockEl.addEventListener('mouseleave', onMouseLeave);
    dockEl.addEventListener('touchstart', onTouchStart, { passive: true });
    dockEl.addEventListener('touchmove', onTouchMove, { passive: true });
    dockEl.addEventListener('touchend', onTouchEnd, { passive: true });
    dockEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      dockEl.removeEventListener('mousemove', onMouseMove);
      dockEl.removeEventListener('mouseleave', onMouseLeave);
      dockEl.removeEventListener('touchstart', onTouchStart);
      dockEl.removeEventListener('touchmove', onTouchMove);
      dockEl.removeEventListener('touchend', onTouchEnd);
      dockEl.removeEventListener('touchcancel', onTouchEnd);
      if (raf !== null) cancelAnimationFrame(raf);
      for (const o of items) {
        if (o.el) { o.el.style.width = ''; o.el.style.height = ''; }
      }
    };
  }, []);

  // The tap press-bounce (round 2) — every dock item AND every quick-action
  // button: touchstart shrinks it (.tap-press, portal-dock.css), touchend
  // either springs it back and THEN fires the tap it stands for (a confirmed
  // tap: the finger barely moved) or just relaxes it (a swipe: the finger
  // was exploring magnification, not tapping — no bounce, no navigation).
  // Delegated on the wrapper so one listener covers the dock AND the qmenu,
  // and "the tap it stands for" is simply the button's own native click,
  // fired programmatically after the bounce — never a second, parallel copy
  // of what each button's onClick already does. Mouse clicks never pass
  // through here at all (no TouchEvent), so they are exactly as before.
  useEffect(() => {
    const wrapEl = wrapRef.current;
    if (!wrapEl) return undefined;
    let pressed: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;

    function pressTarget(e: TouchEvent): HTMLElement | null {
      const el = (e.target as Element | null)?.closest('.di, .fab, .qa');
      return el instanceof HTMLElement ? el : null;
    }

    function onTouchStart(e: TouchEvent) {
      const el = pressTarget(e);
      if (!el) return;
      pressed = el;
      moved = false;
      const t = e.touches[0];
      startX = t?.clientX ?? 0;
      startY = t?.clientY ?? 0;
      el.classList.remove('tap-release');
      el.classList.add('tap-press');
    }

    function onTouchMove(e: TouchEvent) {
      if (!pressed || moved) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.hypot(t.clientX - startX, t.clientY - startY) > SWIPE_THRESHOLD) {
        moved = true;
        pressed.classList.remove('tap-press');
      }
    }

    function onTouchEnd(e: TouchEvent) {
      const el = pressed;
      pressed = null;
      if (!el) return;
      if (moved) { el.classList.remove('tap-press'); return; } // a swipe: no bounce, no tap
      e.preventDefault(); // this tap's own click fires manually, once, after the bounce
      el.classList.remove('tap-press');
      el.classList.add('tap-release');
      releaseTimer = setTimeout(() => {
        el.classList.remove('tap-release');
        el.click();
      }, TAP_RELEASE_MS);
    }

    function onTouchCancel() {
      pressed?.classList.remove('tap-press');
      pressed = null;
    }

    wrapEl.addEventListener('touchstart', onTouchStart, { passive: true });
    wrapEl.addEventListener('touchmove', onTouchMove, { passive: true });
    wrapEl.addEventListener('touchend', onTouchEnd, { passive: false });
    wrapEl.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      wrapEl.removeEventListener('touchstart', onTouchStart);
      wrapEl.removeEventListener('touchmove', onTouchMove);
      wrapEl.removeEventListener('touchend', onTouchEnd);
      wrapEl.removeEventListener('touchcancel', onTouchCancel);
      if (releaseTimer !== null) clearTimeout(releaseTimer);
    };
  }, []);

  function go(next: PortalTab, type?: 'decision' | 'protocol') {
    setOpen(false);
    onNavigate(next, type);
  }

  return (
    <div className={open ? 'dock-wrap qopen' : 'dock-wrap'} ref={wrapRef}>
      <div className="qback" onClick={() => setOpen(false)} aria-hidden={!open} />
      <div className="qmenu">
        {!preview && (
          <Link href="/portal/report" className="qa" onClick={() => setOpen(false)}>
            <span className="qi r"><DockWrenchIcon size={18} /></span>
            פתח תקלה
          </Link>
        )}
        <button type="button" className="qa" onClick={() => go('dec', 'decision')}>
          <span className="qi b"><DecisionsIcon size={18} /></span>
          החלטות
        </button>
        <button type="button" className="qa" onClick={() => go('dec', 'protocol')}>
          <span className="qi y"><DockProtocolIcon size={18} /></span>
          פרוטוקולים
        </button>
        <button type="button" className="qa" onClick={() => go('bal')}>
          <span className="qi g"><DockBalanceIcon size={18} /></span>
          מאזנים
        </button>
      </div>
      <nav className="dock" ref={dockRef} aria-label="ניווט מהיר">
        <button type="button" ref={ovRef} className={tab === 'ov' ? 'di on' : 'di'} onClick={() => go('ov')}>
          <DockHomeIcon /><span className="tip">סקירה</span>
        </button>
        <button type="button" ref={txRef} className={tab === 'tx' ? 'di on' : 'di'} onClick={() => go('tx')}>
          <DockTrendIcon /><span className="tip">הכנסות והוצאות</span>
        </button>
        <button type="button" ref={fabRef} className="fab" aria-label="פעולות מהירות" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <DockPlusIcon /><span className="tip">פעולות מהירות</span>
        </button>
        <button type="button" ref={fundRef} className={tab === 'fund' ? 'di on' : 'di'} onClick={() => go('fund')}>
          <DockFundIcon /><span className="tip">קרן שיפוצים</span>
        </button>
        <button type="button" ref={accRef} className={tab === 'acc' ? 'di on' : 'di'} onClick={() => go('acc')}>
          <DockAccountIcon /><span className="tip">החשבון שלי</span>
        </button>
      </nav>
    </div>
  );
}
