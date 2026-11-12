'use client';

import { usePathname } from 'next/navigation';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { PURCHASING_MODULES } from '@/lib/purchasing/access';
import { usePurchasingUnseen } from '@/components/purchasing/unseen';
import { categoryKind, filterNav } from './nav';
import { NavRail } from './NavRail';
import { useNavPanel } from './useNavPanel';
import { useIsTablet, useTabletOverlay } from './useTabletNav';

// Desktop navigation (md and up): the dark category rail plus the white items panel, in a row
// beside the content. From lg (1024) up the panel PUSHES the content and closes to the rail alone;
// from md to lg (768–1023, tablets) it is an OVERLAY above the content, closed until a category is
// clicked, so the rail alone takes 72px — see useTabletNav and DESIGN.md §14. A category with one
// permitted item is a direct link in the rail and has no panel at all. Below md the whole thing is
// hidden and the drawer in MobileNav takes over. The rail's behaviour lives in useNavPanel (the
// desktop's) and useTabletNav (the tablet's), the markup in NavRail, the item list in nav.tsx.
export function Sidebar() {
  const pathname = usePathname();
  const { can, role } = usePermissions();
  const { signOut } = useAuth();

  // Shared filter — identical item set on desktop (here) and the mobile drawer.
  const unseenQuotes = usePurchasingUnseen(PURCHASING_MODULES.some((m) => can(m, 'view')));
  const { categories } = filterNav(role, can, { '/purchasing': unseenQuotes });
  const panel = useNavPanel(categories, pathname, true);
  const isTablet = useIsTablet();
  const overlay = useTabletOverlay(pathname, isTablet);
  const overlayCategory = categories.find((c) => c.id === overlay.openId && categoryKind(c) === 'panel') ?? null;

  // In the tablet range the rail speaks for the overlay; the desktop state (useNavPanel) is left
  // exactly as it was — no click here reaches it, so the saved choice cannot be overwritten.
  return (
    // md:max-lg:relative/z — the overlay panel and its scrim are positioned against this box and
    // must sit above the content column and its sticky bars (below dialogs and popovers, z-50).
    <aside
      className="hidden shrink-0 md:flex md:max-lg:relative md:max-lg:z-[45]"
      // The overlay dims the content but the keyboard could still Tab into it: when focus moves to
      // something OUTSIDE the sidebar the overlay closes. A blur with no target (the window lost focus,
      // a click on the scrim) is not a Tab-out. Nothing happens on a desktop (no overlay is open there).
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (overlay.openId !== null && next && !e.currentTarget.contains(next)) overlay.close();
      }}
    >
      <NavRail
        categories={categories}
        shown={isTablet ? overlayCategory : panel.shown}
        open={isTablet ? overlayCategory !== null : panel.open}
        animate={isTablet ? false : panel.animate}
        highlightedId={isTablet ? (overlayCategory?.id ?? panel.routeCategoryId) : panel.highlightedId}
        activeHref={panel.activeHref}
        variant="desktop"
        placement={isTablet ? 'overlay' : 'inline'}
        onSelectCategory={isTablet ? overlay.toggle : panel.selectCategory}
        onOpenLink={isTablet ? overlay.close : panel.openLink}
        onClosePanel={isTablet ? overlay.close : panel.closePanel}
        onNavigate={isTablet ? overlay.close : undefined}
        onSignOut={() => signOut()}
      />
    </aside>
  );
}
