'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, LogOut } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { filterNav, NavBrand, Section, NavLink, FooterButton, SETTINGS_ITEM } from './nav';

// Mobile-only navigation. The desktop Sidebar is `hidden md:flex`, so on phones
// there is no nav at all — this hamburger (md:hidden) opens a Sheet with the
// SAME filtered items, active state and disabled state via the shared `nav`
// module (no second list). Drawer opens from the right (`side="right"`) to match
// the desktop Sidebar's physical right edge. See DESIGN.md §15.
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { can, role } = usePermissions();
  const { signOut } = useAuth();

  const { sections, showSettings } = filterNav(role, can);
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="פתח תפריט"
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-row-hover hover:text-ink md:hidden"
      >
        <Menu className="h-[18px] w-[18px]" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          dir="rtl"
          showCloseButton={false}
          className="flex w-[280px] flex-col gap-0 bg-white p-0"
        >
          <SheetTitle className="sr-only">תפריט ניווט</SheetTitle>

          <NavBrand collapsed={false} />

          <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-3.5 pt-1">
            {sections.map((section) => (
              <Section
                key={section.title}
                title={section.title}
                items={section.items}
                pathname={pathname}
                collapsed={false}
                onNavigate={close}
              />
            ))}
          </nav>

          <div className="border-t border-line-soft px-3.5 py-3">
            {showSettings && (
              <NavLink item={SETTINGS_ITEM} pathname={pathname} collapsed={false} onNavigate={close} />
            )}
            <FooterButton
              icon={LogOut}
              label="התנתק"
              collapsed={false}
              onClick={() => { close(); void signOut(); }}
              tone="logout"
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
