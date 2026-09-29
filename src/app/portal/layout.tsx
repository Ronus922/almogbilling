import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

// /portal — the owners portal. Its OWN route group, deliberately a sibling of
// (app) rather than a page inside it, and that is what keeps two promises
// structurally rather than by a flag:
//   • no staff sidebar / header / nav — AppShell is not in this tree;
//   • no personal assistant — AgentFab is rendered by AppShell and nowhere else,
//     so it cannot appear on any page under /portal.
// RTL, Heebo and the Toaster come from the root layout (src/app/layout.tsx).

export const metadata: Metadata = {
  title: 'מגדלי חוף הכרמל — בניין אלמוג',
  description: 'פורטל בעלי הדירות — שקיפות כספית',
};

// White status bar, per ref/otp-states.md ("Set theme-color to #FFFFFF — the
// live app currently shows a blue bar"). Scoped to /portal on purpose: every
// portal screen starts with a white top bar, while the staff app keeps the
// brand bar of the root layout. A segment's viewport overrides the root's.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#FFFFFF',
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-app">{children}</div>;
}
