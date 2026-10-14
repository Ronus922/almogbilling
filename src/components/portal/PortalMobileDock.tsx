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
// rotation, the quick menu's staggered spring entrance, the hover-only
// magnification) are the reference's own.
//
// "החלטות" and "פרוטוקולים" are two quick-action BUTTONS but ONE destination
// (`?tab=dec`) — the dec tab has shown both types in one unified list since
// 05/10/2026 (DESIGN.md's declared exception: no type selector), and this
// dock does not reopen that decision. The reference itself anticipated
// exactly this ("פרוטוקולים הוכנס לתפריט הפעולות — לא יעד ניווט יומיומי").
// "מאזנים" is the one genuinely new destination (`?tab=bal`).
//
// Magnification is ported verbatim from the reference's vanilla-JS loop
// (kaif-ui style: items grow in SIZE, not transform, so neighbours are
// pushed apart) — a lerp-eased requestAnimationFrame loop writing directly
// to each button's style.width/height via refs, never through React state
// (state churn at 60fps would fight the spring feel). It attaches only under
// matchMedia('(hover:hover)') and is a no-op on a touchscreen.

const GROW = 24;
const RANGE = 100;

export function PortalMobileDock({ tab, onNavigate, preview }: {
  tab: PortalTab;
  onNavigate: (next: PortalTab) => void;
  /** The admin preview (/finance?view=resident): no portal session, so the
   *  fault-report quick action is dropped — the same gate PortalShell's own
   *  top-of-content "דיווח על תקלה" button already uses. */
  preview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  // One named ref per dock button (not a dynamically-indexed array of ref
  // callbacks — react-hooks/refs flags a callback factory built in render).
  const ovRef = useRef<HTMLButtonElement>(null);
  const txRef = useRef<HTMLButtonElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const fundRef = useRef<HTMLButtonElement>(null);
  const accRef = useRef<HTMLButtonElement>(null);

  // The reference's magnification loop, translated to refs: direct DOM writes
  // on every frame, state untouched. Re-attaches if `preview` changes the DOM
  // it has to measure (it doesn't, in practice, but the dependency keeps the
  // effect honest about what it reads).
  useEffect(() => {
    if (typeof matchMedia === 'undefined' || !matchMedia('(hover:hover)').matches) return undefined;
    const dockEl = dockRef.current;
    if (!dockEl) return undefined;

    const items: Array<{ el: HTMLButtonElement | null; base: number; cur: number; tgt: number }> = [
      { el: ovRef.current, base: 40, cur: 40, tgt: 40 },
      { el: txRef.current, base: 40, cur: 40, tgt: 40 },
      { el: fabRef.current, base: 46, cur: 46, tgt: 46 },
      { el: fundRef.current, base: 40, cur: 40, tgt: 40 },
      { el: accRef.current, base: 40, cur: 40, tgt: 40 },
    ];
    let mouseX = Infinity;
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
        if (!o.el || mouseX === Infinity) { o.tgt = o.base; continue; }
        const r = o.el.getBoundingClientRect();
        const d = Math.abs(mouseX - (r.left + r.width / 2));
        const f = Math.max(0, 1 - d / RANGE);
        o.tgt = o.base + GROW * f * f;
      }
      if (raf === null) raf = requestAnimationFrame(tick);
    }

    const onMove = (e: MouseEvent) => { mouseX = e.clientX; setTargets(); };
    const onLeave = () => { mouseX = Infinity; setTargets(); };
    dockEl.addEventListener('mousemove', onMove);
    dockEl.addEventListener('mouseleave', onLeave);
    return () => {
      dockEl.removeEventListener('mousemove', onMove);
      dockEl.removeEventListener('mouseleave', onLeave);
      if (raf !== null) cancelAnimationFrame(raf);
      for (const o of items) {
        if (o.el) { o.el.style.width = ''; o.el.style.height = ''; }
      }
    };
  }, [preview]);

  function go(next: PortalTab) {
    setOpen(false);
    onNavigate(next);
  }

  return (
    <div className={open ? 'dock-wrap qopen' : 'dock-wrap'}>
      <div className="qback" onClick={() => setOpen(false)} aria-hidden={!open} />
      <div className="qmenu">
        {!preview && (
          <Link href="/portal/report" className="qa" onClick={() => setOpen(false)}>
            <span className="qi r"><DockWrenchIcon size={18} /></span>
            פתח תקלה
          </Link>
        )}
        <button type="button" className="qa" onClick={() => go('dec')}>
          <span className="qi b"><DecisionsIcon size={18} /></span>
          החלטות
        </button>
        <button type="button" className="qa" onClick={() => go('dec')}>
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
