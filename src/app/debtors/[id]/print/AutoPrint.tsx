'use client';

import { useEffect } from 'react';

/**
 * Fires the browser print dialog once the print page has loaded. Rendered only
 * when the page is opened with ?autoprint=1 (the panel's Printer button). The
 * server-side PDF route navigates WITHOUT the flag, so it never triggers here.
 */
export function AutoPrint({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    // Next paints, fonts settle, then print. A rAF is enough; window.print blocks.
    const t = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(t);
  }, [enabled]);
  return null;
}
