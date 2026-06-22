'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LogOut, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { filterNav, NavBrand, Section, NavLink, FooterButton, SETTINGS_ITEM } from './nav';

const STORAGE_KEY = 'almog:sidebar-collapsed';

export function Sidebar() {
  const pathname = usePathname();
  const { can, role } = usePermissions();
  const { signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // Persisted collapse state — read AFTER mount so the server-rendered markup
  // (always expanded) matches the first client render, avoiding a hydration
  // mismatch. State lives entirely inside the Sidebar; the sidebar's own width
  // shrinks and the main content reflows via flex — no shell plumbing needed.
  useEffect(() => {
    setCollapsed(localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }

  // Shared filter — identical item set on desktop (here) and the mobile drawer.
  const { sections, showSettings } = filterNav(role, can);

  return (
    <aside
      className={cn(
        'relative hidden shrink-0 flex-col border-l border-line bg-white transition-[width] duration-200 md:flex',
        collapsed ? 'w-[80px]' : 'w-[266px]',
      )}
    >
      {/* Collapse / expand toggle — straddles the sidebar's inner (leading) edge. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'פתח תפריט' : 'כווץ תפריט'}
        aria-expanded={!collapsed}
        className="absolute top-1/2 left-0 z-30 grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line bg-white text-ink-2 shadow-soft-md transition-colors hover:text-brand"
      >
        <ChevronRight className={cn('h-4 w-4 transition-transform duration-200', collapsed && 'rotate-180')} />
      </button>

      <NavBrand collapsed={collapsed} />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-3.5 pt-1">
        {sections.map((section) => (
          <Section key={section.title} title={section.title} items={section.items} pathname={pathname} collapsed={collapsed} />
        ))}
      </nav>

      {/* Footer: settings + logout */}
      <div className="border-t border-line-soft px-3.5 py-3">
        {showSettings && (
          <NavLink item={SETTINGS_ITEM} pathname={pathname} collapsed={collapsed} />
        )}
        <FooterButton
          icon={LogOut}
          label="התנתק"
          collapsed={collapsed}
          onClick={() => signOut()}
          tone="logout"
        />
      </div>
    </aside>
  );
}
