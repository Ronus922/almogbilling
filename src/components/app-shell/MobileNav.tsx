'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { PURCHASING_MODULES } from '@/lib/purchasing/access';
import { usePurchasingUnseen } from '@/components/purchasing/unseen';
import { filterNav, type NavCategory } from './nav';
import { NavRail } from './NavRail';
import { useNavPanel } from './useNavPanel';

// Mobile-only navigation. The desktop Sidebar is `hidden md:flex`, so on phones there is no
// nav at all — this hamburger (md:hidden) opens a Sheet holding the SAME rail + panel, built
// from the SAME filtered categories via the shared `nav` module (no second list). The drawer
// opens from the right (`side="right"`) to match the desktop sidebar's physical right edge.
// Its width follows its content: 72px (the rail alone) while no panel is shown, 308px (72 rail +
// 236 panel) when one is, and never wider than the screen. See DESIGN.md §14 + §15.
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { can, role } = usePermissions();

  const unseenQuotes = usePurchasingUnseen(open && PURCHASING_MODULES.some((m) => can(m, 'view')));
  const { categories } = filterNav(role, can, { '/purchasing': unseenQuotes });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="פתח תפריט"
        className="hit-44 relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-row-hover hover:text-ink md:hidden"
      >
        <Menu className="h-[18px] w-[18px]" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          dir="rtl"
          showCloseButton={false}
          className="w-auto max-w-full flex-row gap-0 bg-white p-0 data-[side=right]:border-l-0"
        >
          <SheetTitle className="sr-only">תפריט ניווט</SheetTitle>
          {/* The Sheet unmounts its content when closed, so every open starts from the page: the
              panel shows its category if it is a panel category, otherwise the rail stands alone. */}
          <DrawerNav categories={categories} pathname={pathname} onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function DrawerNav({
  categories, pathname, onClose,
}: {
  categories: NavCategory[];
  pathname: string;
  onClose: () => void;
}) {
  const { signOut } = useAuth();
  const panel = useNavPanel(categories, pathname, false);
  return (
    <NavRail
      categories={categories}
      shown={panel.shown}
      open={panel.open}
      animate={false}
      highlightedId={panel.highlightedId}
      activeHref={panel.activeHref}
      variant="mobile"
      onSelectCategory={panel.selectCategory}
      onOpenLink={panel.openLink}
      onNavigate={onClose}
      onSignOut={() => { onClose(); void signOut(); }}
    />
  );
}
