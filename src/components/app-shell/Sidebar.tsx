'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, LayoutGrid, Users, Truck, CheckSquare, AlertTriangle, Calendar,
  FileText, MessageCircle, MessagesSquare, Bell, Upload, Download, Sliders, MapPin,
  UserCog, Settings as SettingsIcon, Inbox,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/lib/auth/context';

interface MenuItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  module: string;
}

const MAIN_MENU: MenuItem[] = [
  { label: 'לוח מחוונים משימות', icon: LayoutDashboard, module: 'analytics' },
  { label: 'ניהול חיובים',       icon: LayoutGrid, href: '/dashboard', module: 'dashboard' },
  { label: 'רשימת דיירים',       icon: Users, module: 'contacts' },
  { label: 'ספקים',              icon: Truck, href: '/suppliers', module: 'suppliers' },
  { label: 'משימות',             icon: CheckSquare, module: 'tasks' },
  { label: 'תקלות',              icon: AlertTriangle, module: 'issues' },
  { label: 'יומן',               icon: Calendar, module: 'calendar' },
  { label: 'מסמכים',             icon: FileText, module: 'documents' },
  { label: 'צ׳אט ווטסאפ',        icon: MessageCircle, module: 'whatsapp_chat' },
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

  const mainVisible = MAIN_MENU.filter((it) => can(it.module, 'view'));
  const manageVisible = MANAGE_MENU.filter((it) => can(it.module, 'view'));

  return (
    <aside className="hidden w-64 shrink-0 border-l bg-card md:flex md:flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-lg font-extrabold">ניהול אלמוג</h2>
        <button
          type="button"
          className="relative grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          aria-label="התראות"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            +9
          </span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        {mainVisible.length > 0 && (
          <Section title="תפריט ראשי" items={mainVisible} pathname={pathname} />
        )}
        {manageVisible.length > 0 && (
          <div className={cn(mainVisible.length > 0 && 'mt-6')}>
            <Section title="ניהול" items={manageVisible} pathname={pathname} />
          </div>
        )}
      </nav>
    </aside>
  );
}

function Section({ title, items, pathname }: { title: string; items: MenuItem[]; pathname: string }) {
  return (
    <div>
      <h3 className="mb-2 px-3 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="space-y-0.5">
        {items.map((it) => {
          const isActive = !!it.href && (pathname === it.href || pathname.startsWith(it.href + '/'));
          const isReady = !!it.href;
          const body = (
            <span
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive && 'bg-primary/10 text-primary font-medium',
                !isActive && isReady && 'hover:bg-muted',
                !isReady && 'text-muted-foreground cursor-not-allowed opacity-60',
              )}
            >
              <it.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{it.label}</span>
            </span>
          );
          return (
            <li key={it.label}>
              {isReady ? (
                <Link href={it.href!}>{body}</Link>
              ) : (
                <Tooltip>
                  <TooltipTrigger render={<span />}>{body}</TooltipTrigger>
                  <TooltipContent side="left">בקרוב</TooltipContent>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
