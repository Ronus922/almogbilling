'use client';

import { usePathname } from 'next/navigation';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { PURCHASING_MODULES } from '@/lib/purchasing/access';
import { usePurchasingUnseen } from '@/components/purchasing/unseen';
import { filterNav } from './nav';
import { NavRail } from './NavRail';
import { useNavPanel } from './useNavPanel';

// Desktop navigation (md and up): the dark category rail plus the white items panel, in a row
// beside the content — the panel PUSHES the content (no overlay) and closes to the rail alone.
// A category with one permitted item is a direct link in the rail and has no panel at all.
// Below md the whole thing is hidden and the drawer in MobileNav takes over. The rail's
// behaviour lives in useNavPanel, the markup in NavRail, the item list in nav.tsx.
export function Sidebar() {
  const pathname = usePathname();
  const { can, role } = usePermissions();
  const { signOut } = useAuth();

  // Shared filter — identical item set on desktop (here) and the mobile drawer.
  const unseenQuotes = usePurchasingUnseen(PURCHASING_MODULES.some((m) => can(m, 'view')));
  const { categories } = filterNav(role, can, { '/purchasing': unseenQuotes });
  const panel = useNavPanel(categories, pathname, true);

  return (
    <aside className="hidden shrink-0 md:flex">
      <NavRail
        categories={categories}
        shown={panel.shown}
        open={panel.open}
        animate={panel.animate}
        highlightedId={panel.highlightedId}
        activeHref={panel.activeHref}
        variant="desktop"
        onSelectCategory={panel.selectCategory}
        onOpenLink={panel.openLink}
        onClosePanel={panel.closePanel}
        onSignOut={() => signOut()}
      />
    </aside>
  );
}
