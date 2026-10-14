'use client';

import { useEffect, useRef, useState } from 'react';
import { catColor, fmtIls } from '@/lib/portal/ui';
import { useArmOnView } from '@/lib/portal/useArmOnView';

// "לאן הולך הכסף" (ref/almog-portal-overview.md): the first 8 categories
// show immediately, the rest sit behind "הצגת כל N הקטגוריות" — N is
// whatever the period actually has, never the reference's fixed 19. Rows
// animate in once, on scroll (`useArmOnView`, threshold 25%, like the
// reference — round 4, 14/10/2026: shared with PortalOverviewChart and the
// overview's KPI row, rather than each reimplementing the same observer) —
// not on `:hover`, so the entrance looks the same on a phone. Expanding
// re-plays the same animation on just the newly-shown rows (the reference's
// animCats(xtra) on click).

export interface CategoryRow {
  name: string;
  total: number;
  pct: number;
  bar: number;
}

export function PortalCategoryList({ cats }: { cats: readonly CategoryRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const [extraArmed, setExtraArmed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const armed = useArmOnView(box, 0.25);

  if (cats.length === 0) return <div className="cats ovcats"><p className="note">אין הוצאות בתקופה.</p></div>;

  const visible = cats.slice(0, 8);
  const extra = cats.slice(8);

  return (
    <>
      <div className="cats ovcats" ref={box}>
        {visible.map((c, i) => <PortalCategoryRow key={c.name} index={i} go={armed} row={c} />)}
        {expanded && extra.map((c, i) => <PortalCategoryRow key={c.name} index={i + 8} go={extraArmed} row={c} />)}
      </div>
      {extra.length > 0 && (
        <button
          type="button"
          className="more"
          onClick={() => setExpanded((e) => {
            const next = !e;
            if (next) setExtraArmed(true);
            return next;
          })}
        >
          {expanded ? 'הצגה מצומצמת' : `הצגת כל ${cats.length} הקטגוריות`}
        </button>
      )}
    </>
  );
}

function PortalCategoryRow({ index, go, row }: { index: number; go: boolean; row: CategoryRow }) {
  const [live, setLive] = useState({ amt: 0, pct: 0, bar: 0 });
  const delayMs = Math.min(index, 8) * 45;

  useEffect(() => {
    if (!go) return;
    let raf = 0;
    const t0 = performance.now() + delayMs;
    function step(t: number) {
      const p = Math.min(1, Math.max(0, (t - t0) / 800));
      const eased = 1 - (1 - p) ** 3;
      setLive({ amt: row.total * eased, pct: row.pct * eased, bar: row.bar * eased });
      if (t < t0 + 800) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [go, delayMs, row.total, row.pct, row.bar]);

  const color = catColor(index);
  return (
    <div className={`cat${go ? ' go' : ''}`} style={go ? { animationDelay: `${delayMs}ms` } : undefined}>
      <span className="n"><i style={{ background: color }} /><em title={row.name}>{row.name}</em></span>
      <span className="a num out">{fmtIls(live.amt)}<small>{Math.round(live.pct)}%</small></span>
      <div className="bar"><b style={{ width: `${live.bar}%`, background: color }} /></div>
    </div>
  );
}
