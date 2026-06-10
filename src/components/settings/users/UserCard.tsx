'use client';

import { ROLES, ROLE_STYLES, type Role } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';
import type { UserListRow } from '@/lib/db/users';

interface Props {
  user: UserListRow;
  isSelf: boolean;
  onSelect: (id: string) => void;
}

function initialsFromName(fullName: string | null, fallback: string): string {
  const src = (fullName ?? '').trim() || fallback;
  if (!src) return '–';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

function roleLabel(r: Role): string {
  return ROLES.find((x) => x.value === r)?.label ?? r;
}

export function UserCard({ user, isSelf, onSelect }: Props) {
  const styles = ROLE_STYLES[user.role];
  const initials = initialsFromName(user.full_name, user.email);

  return (
    <button
      type="button"
      onClick={() => onSelect(user.id)}
      className="w-full rounded-lg border border-slate-200 bg-white p-4 text-start
                 hover:bg-slate-50 transition-colors cursor-pointer
                 flex items-center gap-3"
    >
      {/* Avatar (DESIGN sect 23) */}
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full
                   bg-blue-100 text-blue-700 text-xs font-bold"
        aria-hidden
      >
        {initials}
      </span>

      {/* Details */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-900 truncate">
            {user.full_name || user.email}
          </span>
          {isSelf && (
            <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 shrink-0">
              אני
            </span>
          )}
        </div>
        <div
          dir="ltr"
          className="text-sm text-muted-foreground tabular-nums truncate text-start"
        >
          {user.email}
        </div>
      </div>

      {/* Active dot (DESIGN sect 23) */}
      <div className="flex items-center gap-1.5 text-xs text-slate-600 shrink-0">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            user.is_active ? 'bg-emerald-500' : 'bg-slate-400',
          )}
          aria-hidden
        />
        {user.is_active ? 'פעיל' : 'מושבת'}
      </div>

      {/* Role badge (DESIGN sect 10 + sect 2 tone) */}
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0',
          styles.bg, styles.fg,
        )}
      >
        {roleLabel(user.role)}
      </span>
    </button>
  );
}
