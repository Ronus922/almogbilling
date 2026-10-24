'use client';

import { useCallback, useEffect, useState } from 'react';

/** Fired by the purchasing screen once a request was opened (its quotes are now
 *  "seen"), so the menu badge and the dashboard card recount without waiting
 *  for the next poll. */
export const PURCHASING_SEEN_EVENT = 'purchasing:seen';

const POLL_MS = 60_000;

/** Requests that hold a portal quote nobody opened yet. `enabled` = the viewer
 *  has the purchasing permission; without it nothing is fetched. */
export function usePurchasingUnseen(enabled: boolean): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/purchasing/unseen', { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as { count?: number };
      setCount(typeof data.count === 'number' ? data.count : 0);
    } catch {
      /* polling — ignore transient errors */
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    window.addEventListener(PURCHASING_SEEN_EVENT, refresh);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener(PURCHASING_SEEN_EVENT, refresh);
    };
  }, [enabled, refresh]);

  return enabled ? count : 0;
}
