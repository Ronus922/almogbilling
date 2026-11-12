'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Two small jobs on the tracking page:
 *   · Grow's success / cancel URL may load INSIDE the payment iframe — then the
 *     page moves itself to the top window, so the resident sees one page;
 *   · right after a payment (?paid=1) the order may still read "ממתין לתשלום"
 *     for a few seconds until Grow's server callback is verified — refresh
 *     every 4 seconds, for at most 2 minutes.
 */
export function TrackAutoRefresh({ waitingForPayment }: { waitingForPayment: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (window.top && window.top !== window.self) {
      window.top.location.href = window.location.href;
    }
  }, []);
  useEffect(() => {
    if (!waitingForPayment) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 120_000) clearInterval(t);
      else router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [waitingForPayment, router]);
  return null;
}
