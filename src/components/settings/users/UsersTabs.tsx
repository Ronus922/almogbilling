'use client';

import {
  Users, Crown, Shield, Briefcase, Eye, Clock, type LucideIcon,
} from 'lucide-react';
import { roleLabel } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

export type UsersTabKey = 'all' | 'super_admin' | 'admin' | 'manager' | 'viewer' | 'invites';

export interface UsersTabCounts {
  all: number;
  super_admin: number;
  admin: number;
  manager: number;
  viewer: number;
  invites: number;
}

interface TabDef {
  key: UsersTabKey;
  label: string;
  icon: LucideIcon;
  activeBg: string;
  badgeIdle: string;
}

// Role-tab labels come from the central roleLabel() dictionary — never hardcode
// them here (avoids drift with ROLES). 'all' / 'invites' are not roles.
const TABS: TabDef[] = [
  { key: 'all',         label: 'הכל',                    icon: Users,     activeBg: 'bg-slate-600',   badgeIdle: 'bg-slate-100 text-slate-600' },
  { key: 'super_admin', label: roleLabel('super_admin'), icon: Crown,     activeBg: 'bg-violet-600',  badgeIdle: 'bg-violet-100 text-violet-700' },
  { key: 'admin',       label: roleLabel('admin'),       icon: Shield,    activeBg: 'bg-blue-600',    badgeIdle: 'bg-blue-100 text-blue-700' },
  { key: 'manager',     label: roleLabel('manager'),     icon: Briefcase, activeBg: 'bg-emerald-600', badgeIdle: 'bg-emerald-100 text-emerald-700' },
  { key: 'viewer',      label: roleLabel('viewer'),      icon: Eye,       activeBg: 'bg-slate-600',   badgeIdle: 'bg-slate-100 text-slate-600' },
  { key: 'invites',     label: 'ממתינים',                icon: Clock,     activeBg: 'bg-amber-600',   badgeIdle: 'bg-amber-100 text-amber-700' },
];

export function UsersTabs({
  active,
  counts,
  onChange,
}: {
  active: UsersTabKey;
  counts: UsersTabCounts;
  onChange: (k: UsersTabKey) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {TABS.map((t) => {
        const isActive = t.key === active;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              'h-10 w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs sm:text-sm font-semibold transition-colors cursor-pointer',
              isActive
                ? `${t.activeBg} text-white`
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50',
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{t.label}</span>
            <span
              className={cn(
                'inline-flex items-center justify-center text-xs font-bold px-1.5 py-0.5 rounded-full',
                isActive ? 'bg-white/25 text-white' : t.badgeIdle,
              )}
            >
              {counts[t.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
