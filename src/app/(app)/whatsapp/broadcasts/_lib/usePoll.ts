'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Controlled polling for active broadcasts only. Fetches once on mount, then on an
// interval ONLY while `shouldContinue(data)` is true — so polling stops the moment
// a broadcast reaches a terminal status (no aggressive global polling, no work
// after done). Refreshes just this hook's data; never a full page reload.
export interface Poll<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function usePoll<T>(
  fetcher: () => Promise<T>,
  opts: { intervalMs: number; shouldContinue: (data: T) => boolean; deps?: unknown[] },
): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRef = useRef(opts.shouldContinue);
  shouldRef.current = opts.shouldContinue;

  const tick = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      setData(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאת רשת');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const refetch = useCallback(async () => { await tick(); }, [tick]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    const loop = async () => {
      const next = await tick();
      if (cancelled) return;
      // Keep polling only while there is live work.
      if (next !== null && shouldRef.current(next)) {
        timer.current = setTimeout(loop, opts.intervalMs);
      }
    };
    setLoading(true);
    void loop();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // Re-arm when the interval or the caller-supplied deps change.
  }, [opts.intervalMs, tick, ...(opts.deps ?? [])]);

  return { data, loading, error, refetch };
}
