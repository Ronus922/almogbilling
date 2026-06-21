'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2, LayoutDashboard, LayoutGrid, Users, Truck, CheckSquare, AlertTriangle,
  Calendar, FileText, MessageCircle, MessagesSquare, Bell, Sliders,
  MapPin, UserCog, Settings as SettingsIcon, LogOut, ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAuth, usePermissions } from '@/lib/auth/context';
import type { Role } from '@/lib/permissions/constants';

const STORAGE_KEY = 'almog:sidebar-collapsed';

type BadgeTone = 'default' | 'warn' | 'green';

interface MenuItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  module?: string;
  /** Optional role gate; when present it overrides the module-based `can` check.
   *  Used for /overview, which is role-gated (any non-viewer) rather than tied
   *  to a permission module. */
  visible?: (role: Role) => boolean;
  /** Live count badge. Rendered ONLY when a real source sets `count`. No item
   *  carries a hard-coded demo number — the badge capability stays dormant
   *  until a real data source is wired (see DESIGN.md §14). */
  badge?: { count: number; tone?: BadgeTone };
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

// Sections mirror the mockup (ראשי / ניהול / תקשורת). Every item keeps its
// existing route + permission module — only the grouping/section is new, so
// RBAC is preserved 1:1 (a section with no permitted items hides itself).
const SECTIONS: MenuSection[] = [
  {
    title: 'ראשי',
    items: [
      { label: 'לוח מחוונים',   icon: LayoutDashboard, href: '/overview', visible: (role) => role !== 'viewer' },
      { label: 'ניהול חיובים',  icon: LayoutGrid, href: '/dashboard', module: 'dashboard' },
      { label: 'רשימת דיירים',  icon: Users, href: '/contacts', module: 'contacts' },
      { label: 'צ׳אט וואטסאפ',  icon: MessageCircle, href: '/messages', module: 'whatsapp_chat' },
      { label: 'צ׳אט פנימי',    icon: MessagesSquare, href: '/chat', module: 'internal_chat' },
      { label: 'ספקים',         icon: Truck, href: '/suppliers', module: 'suppliers' },
      { label: 'מסמכים',        icon: FileText, href: '/documents', module: 'documents' },
      { label: 'תקלות',         icon: AlertTriangle, href: '/issues', module: 'issues' },
      { label: 'משימות',        icon: CheckSquare, href: '/tasks', module: 'tasks' },
      { label: 'תזכורות',       icon: Bell, href: '/user-reminders', module: 'user_reminders' },
      { label: 'יומן',          icon: Calendar, href: '/calendar', module: 'calendar' },
    ],
  },
  {
    title: 'ניהול',
    items: [
      { label: 'ניהול סטטוס חיובים', icon: Sliders, href: '/statuses', module: 'status_management' },
      { label: 'תבניות ווטסאפ',      icon: MessageCircle, href: '/whatsapp-templates', module: 'whatsapp_templates' },
      { label: 'ניהול אזורים',       icon: MapPin, href: '/areas', module: 'rooms_areas' },
      { label: 'משתמשים',            icon: UserCog, href: '/settings/users', module: 'users_management' },
      // Hidden from the nav 2026-06-18 — data import/export. Pages, routes, /import,
      // import_runs and all logic remain intact; restore = uncomment these two lines
      // and re-add the Upload/Download imports. Routes still reachable by URL.
      // { label: 'ייבוא נתונים',       icon: Upload, href: '/import', module: 'import' },
      // { label: 'ייצוא נתונים',       icon: Download, module: 'export' },
    ],
  },
];

const SETTINGS_ITEM: MenuItem = { label: 'הגדרות', icon: SettingsIcon, href: '/settings', module: 'settings' };

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

  // Role-gated items (visible predicate) override the module-based `can` check.
  const isVisible = (it: MenuItem) =>
    it.visible ? it.visible(role) : it.module ? can(it.module, 'view') : true;

  const sections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter(isVisible) }))
    .filter((s) => s.items.length > 0);
  const showSettings = isVisible(SETTINGS_ITEM);

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

      {/* Brand block */}
      <div
        className={cn(
          'flex items-center gap-3 border-b border-line-soft pb-4 pt-5',
          collapsed ? 'justify-center px-0' : 'px-5',
        )}
      >
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-gradient-to-br from-brand to-brand-dark text-white shadow-[0_10px_20px_-8px_rgba(61,90,254,0.6)]">
          <Building2 className="h-[22px] w-[22px]" />
        </span>
        {!collapsed && (
          <span className="truncate text-[22px] font-black leading-none tracking-tight text-ink">ניהול אלמוג</span>
        )}
      </div>

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

function Section({
  title, items, pathname, collapsed,
}: { title: string; items: MenuItem[]; pathname: string; collapsed: boolean }) {
  return (
    <div>
      {collapsed ? (
        <div className="mx-auto my-2 h-px w-8 bg-line-soft" aria-hidden />
      ) : (
        <p className="px-3 pb-1.5 pt-4 text-[11px] font-extrabold tracking-[0.06em] text-ink-ghost">{title}</p>
      )}
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.label}>
            <NavLink item={it} pathname={pathname} collapsed={collapsed} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'bg-[#eef1f6] text-[#64748b]',
  warn: 'bg-[#fdecec] text-[#dc2626]',
  green: 'bg-[#e7f7ee] text-[#16a34a]',
};

function NavLink({ item, pathname, collapsed }: { item: MenuItem; pathname: string; collapsed: boolean }) {
  const isActive = !!item.href && (pathname === item.href || pathname.startsWith(item.href + '/'));
  const isReady = !!item.href;
  const Icon = item.icon;

  const body = (
    <span
      className={cn(
        'group flex h-11 items-center gap-3 rounded-xl text-sm font-semibold transition-colors',
        collapsed ? 'justify-center px-0' : 'px-3',
        isActive && 'bg-gradient-to-l from-brand-dark to-brand text-white shadow-[0_10px_20px_-9px_rgba(61,90,254,0.6)]',
        !isActive && isReady && 'text-ink-2 hover:bg-row-hover hover:text-ink',
        !isReady && 'cursor-not-allowed text-ink-ghost',
      )}
    >
      <Icon
        className={cn(
          'h-5 w-5 shrink-0 transition-colors',
          isActive ? 'text-white' : 'text-ink-3 group-hover:text-brand',
        )}
      />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && item.badge && item.badge.count > 0 && (
        <span
          className={cn(
            'grid h-[21px] min-w-[21px] place-items-center rounded-full px-1.5 text-[11.5px] font-extrabold',
            isActive ? 'bg-white/25 text-white' : BADGE_TONE[item.badge.tone ?? 'default'],
          )}
        >
          {item.badge.count}
        </span>
      )}
    </span>
  );

  // Collapsed items (and any not-yet-ready item) get a tooltip: the label when
  // collapsed, "בקרוב" when the route isn't wired yet.
  if (collapsed || !isReady) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          {isReady ? <Link href={item.href!}>{body}</Link> : body}
        </TooltipTrigger>
        <TooltipContent side="left">{isReady ? item.label : 'בקרוב'}</TooltipContent>
      </Tooltip>
    );
  }
  return <Link href={item.href!}>{body}</Link>;
}

function FooterButton({
  icon: Icon, label, collapsed, onClick, tone,
}: { icon: LucideIcon; label: string; collapsed: boolean; onClick: () => void; tone?: 'logout' }) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'group flex h-11 w-full items-center gap-3 rounded-xl text-sm font-semibold transition-colors',
        collapsed ? 'justify-center px-0' : 'px-3',
        tone === 'logout'
          ? 'text-[#b91c1c] hover:bg-[#fdecec]'
          : 'text-ink-2 hover:bg-row-hover hover:text-ink',
      )}
    >
      <Icon
        className={cn(
          'h-5 w-5 shrink-0 transition-colors',
          tone === 'logout' ? 'text-[#dc2626]' : 'text-ink-3 group-hover:text-brand',
        )}
      />
      {!collapsed && <span className="flex-1 truncate text-start">{label}</span>}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>{button}</TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return button;
}
