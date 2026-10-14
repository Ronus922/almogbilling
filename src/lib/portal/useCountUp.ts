'use client';

import { useEffect, useState } from 'react';

/** Animates a number from 0 to `target` over `duration`ms, ease-out cubic —
 *  the overview reference's count(). Pure rAF, no `:hover`/pointer
 *  dependency, so it behaves identically on touch and mouse. Server render
 *  and the client's first paint both show 0 (the effect only starts after
 *  mount), so there is no hydration mismatch; restarts whenever `target`
 *  changes (e.g. the 12/6-month span switch). The caller formats the live
 *  value (fmtIls / fmtSigned) so rounding stays in one place.
 *
 *  `armed` (round 4, 14/10/2026): while false the value stays at 0 and no
 *  rAF loop runs — the caller gates this on `useArmOnView` so the KPI only
 *  counts up once it has actually scrolled into view, not at mount (which
 *  on a phone finishes off-screen, under the fold, before it is seen). */
export function useCountUp(target: number, duration = 900, armed = true): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!armed) return;
    let raf = 0;
    const t0 = performance.now();
    function step(t: number) {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - (1 - p) ** 3;
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, armed]);

  return value;
}
