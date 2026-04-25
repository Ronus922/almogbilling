'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, LayoutGrid, Users, Truck, CheckSquare, AlertTriangle, Calendar,
  FileText, MessageCircle, MessagesSquare, Bell, Upload, Download, Sliders, MapPin, Shield,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface MenuItem {
  label: string;
  href?: string;
  icon: LucideIcon;
}

const MAIN_MENU: MenuItem[] = [
  { label: 'לוח מחוונים משימות', icon: LayoutDashboard },
  { label: 'ניהול חיובים', icon: LayoutGrid, href: '/dashboard' },
  { label: 'רשימת דיירים', icon: Users },
  { label: 'ספקים', icon: Truck },
  { label: 'משימות', icon: CheckSquare },
  { label: 'תקלות', icon: AlertTriangle },
  { label: 'יומן', icon: Calendar },
  { label: 'מסמכים', icon: FileText },
  { label: 'צ׳אט ווטסאפ', icon: MessageCircle },
  { label: 'צ׳אט פנימי', icon: MessagesSquare },
  { label: 'תזכורות', icon: Bell },
];

const MANAGE_MENU: MenuItem[] = [
  { label: 'ייבוא נתונים', icon: Upload, href: '/import' },
  { label: 'ייצוא נתונים', icon: Download },
  { label: 'ניהול סטטוס חיובים', icon: Sliders, href: '/statuses' },
  { label: 'תבניות ווטסאפ', icon: MessageCircle },
  { label: 'ניהול אזורים', icon: MapPin },
  { label: 'הרשאות', icon: Shield },
];

export function Sidebar() {
  const pathname = usePathname();

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
        <Section title="תפריט ראשי" items={MAIN_MENU} pathname={pathname} />
        <div className="mt-6">
          <Section title="ניהול" items={MANAGE_MENU} pathname={pathname} />
        </div>
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
          const isActive = !!it.href && pathname === it.href;
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
