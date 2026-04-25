import type { ReactNode } from 'react';

// The (auth) route group has no shared server logic — each page wraps its own
// <AuthLayout variant="..."> so the right-side features card can vary per screen.
export default function AuthRouteLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
