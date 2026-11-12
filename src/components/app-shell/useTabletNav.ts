'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

// Tablet navigation (DESIGN.md §14, "טאבלט"): from `md` (768px) up to, not including, `lg` (1024px)
// the items panel is not a column beside the content but an overlay on top of it, closed until a
// category is clicked — the rail alone keeps its 72px, so the content gets 696px at 768 (with the
// panel pushing it was 460px and the Header was cut). Below 768 the drawer takes over and from
// 1024 up nothing changed: the panel pushes the content and its open/closed choice is saved.
//
// This file owns the two things only the tablet needs: knowing that the window is in that range,
// and the overlay's own state. It NEVER touches `almog:sidebar-collapsed` — that is the desktop's
// saved choice (useNavPanel), and using the menu on an iPad must not rewrite it.

// The same window as Tailwind's `md:max-lg:` — 48rem ≤ width < 64rem. In a media query `rem` is the
// browser's initial font size (16px), not <html>'s 17px, so this is 768 ≤ width < 1024 exactly,
// like the utilities.
const TABLET_QUERY = '(width >= 48rem) and (width < 64rem)';

function subscribe(listener: () => void): () => void {
  const mq = window.matchMedia(TABLET_QUERY);
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/** True while the window is in the tablet range. The server and the hydration render say false (the
 *  markup is the same for every width; the CSS hides the inline panel in this range, so nothing
 *  flashes), the client then reads the real value. */
export function useIsTablet(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(TABLET_QUERY).matches, () => false);
}

/** The overlay: which panel category it lists (null = closed). It closes on a route change, when the
 *  window leaves the tablet range, and on Escape — which also hands the focus back to the rail
 *  button that opened it. A click outside is the scrim's (NavRail). */
export function useTabletOverlay(pathname: string, isTablet: boolean) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [seenPath, setSeenPath] = useState(pathname);

  // Derived during render, like useNavPanel: no effect, no frame with a stale overlay.
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    setOpenId(null);
  }
  if (!isTablet && openId !== null) setOpenId(null);

  useEffect(() => {
    if (openId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpenId(null);
      document.querySelector<HTMLElement>(`aside [data-nav-category="${openId}"]`)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);

  return {
    openId,
    /** A click on a PANEL category: opens it, switches to it, or — on the one already shown — closes. */
    toggle: (id: string) => setOpenId((cur) => (cur === id ? null : id)),
    close: () => setOpenId(null),
  };
}
