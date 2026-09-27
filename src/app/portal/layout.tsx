import type { Metadata } from 'next';
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

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-app">{children}</div>;
}
