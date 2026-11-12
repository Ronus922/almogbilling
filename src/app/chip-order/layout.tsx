import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

// /chip-order — the PUBLIC chip-order page and its tracking page. Its own route
// tree, a sibling of (app) like /portal and /quote: no staff shell, no
// assistant, and no session — the proxy matcher (src/proxy.ts) never covers it.
// RTL, fonts and the Toaster come from the root layout.

export const metadata: Metadata = {
  title: 'הזמנת צ׳יפים למעלית — בניין אלמוג',
  description: 'הזמנה ותשלום של צ׳יפים למעלית',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#2B3FB8',
};

export default function ChipOrderLayout({ children }: { children: ReactNode }) {
  return children;
}
