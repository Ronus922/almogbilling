'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Arms once, the first time the given ref's element scrolls into the
 *  viewport past `threshold` — the shared trigger behind every entrance
 *  animation in the portal (KPI count-up, the overview chart's draw-in,
 *  "לאן הולך הכסף"'s rows): an element that mounts below the fold stays at
 *  its "before" state (0, undrawn) until the visitor actually scrolls to it,
 *  instead of animating to completion off-screen on mount (round 4,
 *  14/10/2026 — Phase 0 found this was exactly why the chart/KPI animation
 *  read as "not working" on a phone, where it sits under the balance card
 *  and the KPIs). Never re-arms — a remount (the chart's own
 *  `key={view}-{span}`) is how a replay is triggered, same as before. */
export function useArmOnView(ref: RefObject<HTMLElement | null>, threshold = 0.25): boolean {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (armed) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) { setArmed(true); io.disconnect(); }
    }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, armed, threshold]);

  return armed;
}
