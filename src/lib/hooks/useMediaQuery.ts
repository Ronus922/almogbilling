'use client';

import { useSyncExternalStore } from 'react';

/** Whether `query` matches, false on the server and during hydration (so the
 *  first client render equals the server's), then live. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
