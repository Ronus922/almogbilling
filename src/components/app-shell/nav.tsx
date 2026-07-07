'use client';

import Link from 'next/link';
import {
  Building2, LayoutDashboard, LayoutGrid, Users, Truck, CheckSquare, AlertTriangle,
  Calendar, FileText, MessageCircle, MessagesSquare, Bell, Sliders, Megaphone,
  MapPin, UserCog, Settings as SettingsIcon, type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Action, Role } from '@/lib/permissions/constants';

// Single source of truth for the app navigation — the item config, the role/
// permission filter, and the link/brand renderers. Consumed by BOTH the desktop
// Sidebar and the mobile drawer (MobileNav) so the two can never drift. See
// DESIGN.md §14 (Sidebar) + §15 (Header / mobile drawer).

export type BadgeTone = 'default' | 'warn' | 'green';

export interface MenuItem {
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

export interface MenuSection {
  title: string;
  items: MenuItem[];
}

// Unified single list — no section sub-headers. Order: daily work + comms first,
// then the system-management entries. Every item keeps its route + permission
// module, so RBAC stays 1:1 (an unpermitted item just hides).
export const SECTIONS: MenuSection[] = [
  {
    title: '',
    items: [
      { label: 'לוח מחוונים',        icon: LayoutDashboard, href: '/overview', visible: (role) => role !== 'viewer' },
      { label: 'ניהול חיובים',       icon: LayoutGrid, href: '/dashboard', module: 'dashboard' },
      { label: 'רשימת דיירים',       icon: Users, href: '/contacts', module: 'contacts' },
      { label: 'צ׳אט וואטסאפ',       icon: MessageCircle, href: '/messages', module: 'whatsapp_chat' },
      { label: 'תפוצות וואטסאפ',     icon: Megaphone, href: '/whatsapp/broadcasts', module: 'whatsapp_chat' },
      { label: 'צ׳אט פנימי',         icon: MessagesSquare, href: '/chat', module: 'internal_chat' },
      { label: 'ספקים',              icon: Truck, href: '/suppliers', module: 'suppliers' },
      { label: 'מסמכים',             icon: FileText, href: '/documents', module: 'documents' },
      { label: 'תקלות',              icon: AlertTriangle, href: '/issues', module: 'issues' },
      { label: 'משימות',             icon: CheckSquare, href: '/tasks', module: 'tasks' },
      { label: 'תזכורות',            icon: Bell, href: '/user-reminders', module: 'user_reminders' },
      { label: 'יומן',               icon: Calendar, href: '/calendar', module: 'calendar' },
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

export const SETTINGS_ITEM: MenuItem = { label: 'הגדרות', icon: SettingsIcon, href: '/settings', module: 'settings' };

/** The ONE nav-visibility filter — role-gated items override the module `can`
 *  check; a section with no permitted items hides itself. Both nav surfaces call
 *  this, so desktop and mobile always show the exact same set. */
export function filterNav(
  role: Role,
  can: (module: string, action: Action) => boolean,
): { sections: MenuSection[]; showSettings: boolean } {
  const isVisible = (it: MenuItem) =>
    it.visible ? it.visible(role) : it.module ? can(it.module, 'view') : true;
  const sections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter(isVisible) }))
    .filter((s) => s.items.length > 0);
  return { sections, showSettings: isVisible(SETTINGS_ITEM) };
}

/** Brand block at the top of either nav surface — `h-16` + `border-b` matches the
 *  Header so the bottom borders align (DESIGN.md §32). Collapsed → logo only. */
export function NavBrand({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        'flex h-16 shrink-0 items-center gap-3 border-b border-line',
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
  );
}

export function Section({
  title, items, pathname, collapsed, onNavigate,
}: {
  title: string;
  items: MenuItem[];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div>
      {title ? (
        collapsed ? (
          <div className="mx-auto my-2 h-px w-8 bg-line-soft" aria-hidden />
        ) : (
          <p className="px-3 pb-1.5 pt-4 text-[11px] font-extrabold tracking-[0.06em] text-ink-ghost">{title}</p>
        )
      ) : null}
      <ul className="space-y-1 pt-1">
        {items.map((it) => (
          <li key={it.label}>
            <NavLink item={it} pathname={pathname} collapsed={collapsed} onNavigate={onNavigate} />
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

export function NavLink({
  item, pathname, collapsed, onNavigate,
}: {
  item: MenuItem;
  pathname: string;
  collapsed: boolean;
  /** Fired after a real navigation — lets the mobile drawer close itself. */
  onNavigate?: () => void;
}) {
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
          {isReady ? <Link href={item.href!} onClick={onNavigate}>{body}</Link> : body}
        </TooltipTrigger>
        <TooltipContent side="left">{isReady ? item.label : 'בקרוב'}</TooltipContent>
      </Tooltip>
    );
  }
  return <Link href={item.href!} onClick={onNavigate}>{body}</Link>;
}

export function FooterButton({
  icon: Icon, label, collapsed, onClick, tone,
}: {
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  onClick: () => void;
  tone?: 'logout';
}) {
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
