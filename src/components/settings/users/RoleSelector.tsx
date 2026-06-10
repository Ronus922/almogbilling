'use client';

import { Crown, Shield, Briefcase, Eye, type LucideIcon } from 'lucide-react';
import { ROLES, ROLE_STYLES, type Role } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

interface Props {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
  /** Hide super_admin option (used in invite dialog — only super_admin can be created via SQL). */
  excludeSuperAdmin?: boolean;
}

const ROLE_ICONS: Record<Role, LucideIcon> = {
  super_admin: Crown,
  admin: Shield,
  manager: Briefcase,
  viewer: Eye,
};

export function RoleSelector({ value, onChange, disabled, excludeSuperAdmin }: Props) {
  const options = excludeSuperAdmin ? ROLES.filter((r) => r.value !== 'super_admin') : ROLES;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((meta) => {
        const Icon = ROLE_ICONS[meta.value];
        const styles = ROLE_STYLES[meta.value];
        const active = value === meta.value;
        return (
          <button
            key={meta.value}
            type="button"
            onClick={() => onChange(meta.value)}
            disabled={disabled}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3 text-start transition-colors',
              active
                ? cn('border-transparent ring-2', styles.ring, styles.bg)
                : 'border-slate-200 bg-white hover:bg-slate-50',
              disabled && 'opacity-60 cursor-not-allowed',
            )}
          >
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full', styles.bg, styles.fg)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className={cn('text-sm font-bold', active ? styles.fg : 'text-slate-900')}>
                {meta.label}
              </div>
              <div className="mt-0.5 text-xs text-slate-500 line-clamp-2">
                {meta.description}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
