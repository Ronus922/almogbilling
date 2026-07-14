'use client';

import { ChevronLeft, Mail, Phone } from 'lucide-react';
import { ROLE_STYLES, roleLabel, type Role } from '@/lib/permissions/constants';
import { formatPhoneDisplay } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { UserListRow } from '@/lib/db/users';

interface Props {
  user: UserListRow;
  isSelf: boolean;
  onSelect: (id: string) => void;
}

// Per-role accent: avatar tint + card border, in the same hue as the role badge
// (ROLE_STYLES). Groups the list visually by role.
const ROLE_ACCENT: Record<Role, { avatar: string; border: string }> = {
  super_admin: { avatar: 'bg-violet-100 text-violet-700',  border: 'border-violet-200' },
  admin:       { avatar: 'bg-blue-100 text-blue-700',      border: 'border-blue-200' },
  manager:     { avatar: 'bg-emerald-100 text-emerald-700', border: 'border-emerald-200' },
  viewer:      { avatar: 'bg-slate-100 text-slate-600',    border: 'border-slate-200' },
  cleaner:     { avatar: 'bg-sky-100 text-sky-700',        border: 'border-sky-200' },
  maintenance: { avatar: 'bg-amber-100 text-amber-700',    border: 'border-amber-200' },
};

function initialsFromName(fullName: string | null, fallback: string): string {
  const src = (fullName ?? '').trim() || fallback;
  if (!src) return '–';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

export function UserCard({ user, isSelf, onSelect }: Props) {
  const styles = ROLE_STYLES[user.role];
  const accent = ROLE_ACCENT[user.role];
  const initials = initialsFromName(user.full_name, user.email);

  return (
    <button
      type="button"
      onClick={() => onSelect(user.id)}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border bg-white p-4 text-start',
        'cursor-pointer transition-colors hover:bg-slate-50',
        accent.border,
      )}
    >
      {/* Avatar (DESIGN §23) — role-tinted */}
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold',
          accent.avatar,
        )}
        aria-hidden
      >
        {initials}
      </span>

      {/* Details — name + contact line (phone · email) */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-slate-900">
            {user.full_name || user.email}
          </span>
          {isSelf && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
              אני
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-sm text-muted-foreground">
          {user.notification_phone && (
            <span dir="ltr" className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <Phone className="h-3.5 w-3.5 text-slate-400" />
              {formatPhoneDisplay(user.notification_phone)}
            </span>
          )}
          <span dir="ltr" className="inline-flex min-w-0 items-center gap-1">
            <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="truncate">{user.email}</span>
          </span>
        </div>
      </div>

      {/* Role badge — fixed-width column (DESIGN §9b + §2 tone) so badges align */}
      <div className="flex shrink-0 sm:w-28">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
            styles.bg, styles.fg,
          )}
        >
          {roleLabel(user.role)}
        </span>
      </div>

      {/* Status — fixed-width column (desktop) so dots/labels align */}
      <div className="hidden w-20 shrink-0 items-center gap-1.5 text-xs text-slate-600 sm:flex">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            user.is_active ? 'bg-emerald-500' : 'bg-slate-400',
          )}
          aria-hidden
        />
        {user.is_active ? 'פעיל' : 'מושבת'}
      </div>

      {/* Open affordance (DESIGN §22 — RTL "open/next" = ChevronLeft) */}
      <ChevronLeft className="hidden h-4 w-4 shrink-0 text-slate-300 sm:block" aria-hidden />
    </button>
  );
}
