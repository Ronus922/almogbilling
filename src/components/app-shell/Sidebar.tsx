'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, LayoutGrid, Users, Truck, CheckSquare, AlertTriangle, Calendar,
  FileText, MessageCircle, MessagesSquare, Bell, Upload, Download, Sliders, MapPin,
  UserCog, Settings as SettingsIcon, Inbox, ChevronRight, ChevronLeft,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/lib/auth/context';

const STORAGE_KEY = 'almog:sidebar-collapsed';

interface MenuItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  module: string;
}

const MAIN_MENU: MenuItem[] = [
  { label: 'לוח מחוונים משימות', icon: LayoutDashboard, module: 'analytics' },
  { label: 'ניהול חיובים',       icon: LayoutGrid, href: '/dashboard', module: 'dashboard' },
  { label: 'רשימת דיירים',       icon: Users, href: '/contacts', module: 'contacts' },
  { label: 'ספקים',              icon: Truck, href: '/suppliers', module: 'suppliers' },
  { label: 'משימות',             icon: CheckSquare, module: 'tasks' },
  { label: 'תקלות',              icon: AlertTriangle, module: 'issues' },
  { label: 'יומן',               icon: Calendar, module: 'calendar' },
  { label: 'מסמכים',             icon: FileText, module: 'documents' },
  { label: 'הודעות',             icon: MessageCircle, href: '/messages', module: 'whatsapp_chat' },
  { label: 'צ׳אט פנימי',         icon: MessagesSquare, module: 'internal_chat' },
  { label: 'תזכורות',            icon: Bell, module: 'reminders' },
];

const MANAGE_MENU: MenuItem[] = [
  { label: 'ייבוא נתונים',       icon: Upload, href: '/import', module: 'import' },
  { label: 'ייצוא נתונים',       icon: Download, module: 'export' },
  { label: 'ניהול סטטוס חיובים', icon: Sliders, href: '/statuses', module: 'status_management' },
  { label: 'תבניות ווטסאפ',      icon: MessageCircle, href: '/whatsapp-templates', module: 'whatsapp_templates' },
  { label: 'הודעות לא משויכות',  icon: Inbox, href: '/whatsapp-unlinked', module: 'whatsapp' },
  { label: 'ניהול אזורים',       icon: MapPin, module: 'rooms_areas' },
  { label: 'משתמשים',            icon: UserCog, href: '/settings/users', module: 'users_management' },
  { label: 'הגדרות',             icon: SettingsIcon, href: '/settings', module: 'settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { can } = usePermissions();
  const [collapsed, setCollapsed] = useState(false);

  // Persisted collapse state (read after mount to avoid a hydration mismatch).
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

  const mainVisible = MAIN_MENU.filter((it) => can(it.module, 'view'));
  const manageVisible = MANAGE_MENU.filter((it) => can(it.module, 'view'));

  return (
    <aside
      className={cn(
        'relative hidden shrink-0 border-l border-line bg-white transition-[width] duration-200 md:flex md:flex-col',
        collapsed ? 'w-[68px]' : 'w-[248px]',
      )}
    >
      {/* Collapse / expand toggle — straddles the sidebar's inner (leading) edge. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'פתח תפריט' : 'כווץ תפריט'}
        aria-expanded={!collapsed}
        className="absolute top-1/2 left-0 z-20 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line bg-white text-ink-2 shadow-soft-sm transition-colors hover:bg-row-hover hover:text-brand"
      >
        {collapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden p-3">
        {mainVisible.length > 0 && (
          <Section title="תפריט ראשי" items={mainVisible} pathname={pathname} collapsed={collapsed} />
        )}
        {manageVisible.length > 0 && (
          <div className={cn(mainVisible.length > 0 && 'mt-4 border-t border-line-soft pt-4')}>
            <Section title="ניהול" items={manageVisible} pathname={pathname} collapsed={collapsed} />
          </div>
        )}
      </nav>
    </aside>
  );
}

function Section({
  title, items, pathname, collapsed,
}: { title: string; items: MenuItem[]; pathname: string; collapsed: boolean }) {
  return (
    <div>
      {collapsed ? (
        <div className="mx-2 mb-2 h-px bg-line-soft" aria-hidden />
      ) : (
        <h3 className="mb-2 px-3 text-[11px] font-bold tracking-[0.06em] text-ink-ghost">{title}</h3>
      )}
      <ul className="space-y-0.5">
        {items.map((it) => {
          const isActive = !!it.href && (pathname === it.href || pathname.startsWith(it.href + '/'));
          const isReady = !!it.href;
          const body = (
            <span
              className={cn(
                'relative flex h-10 items-center gap-3 rounded-[10px] text-[13.5px] transition-colors',
                collapsed ? 'justify-center px-0' : 'px-3',
                isActive && 'bg-brand-soft font-semibold text-brand-text',
                !isActive && isReady && 'text-ink-2 hover:bg-row-hover',
                !isReady && 'text-ink-ghost cursor-not-allowed',
              )}
            >
              {isActive && (
                <span className="absolute inset-y-1.5 right-0 w-[3px] rounded-full bg-brand" aria-hidden />
              )}
              <it.icon className={cn('h-[18px] w-[18px] shrink-0', isActive && 'text-brand')} />
              {!collapsed && <span className="truncate">{it.label}</span>}
            </span>
          );
          // When collapsed, every item gets a label tooltip; otherwise only the
          // not-yet-ready items show the "בקרוב" tooltip (unchanged behaviour).
          const wrapped =
            collapsed || !isReady ? (
              <Tooltip>
                <TooltipTrigger render={<span className="block" />}>
                  {isReady ? <Link href={it.href!}>{body}</Link> : body}
                </TooltipTrigger>
                <TooltipContent side="left">{isReady ? it.label : 'בקרוב'}</TooltipContent>
              </Tooltip>
            ) : (
              <Link href={it.href!}>{body}</Link>
            );
          return <li key={it.label}>{wrapped}</li>;
        })}
      </ul>
    </div>
  );
}
