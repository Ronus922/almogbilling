'use client';

import { useAuth } from '@/lib/auth/context';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import { ROLE_STYLES, roleLabel } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const initial = (user.full_name || user.username).charAt(0).toUpperCase();
  const roleStyles = ROLE_STYLES[user.role];

  return (
    <div className="flex items-center gap-3">
      <div className="text-end leading-tight">
        {/* Role badge derives from the actual role (ROLE_STYLES + roleLabel) — never
            from the display name, so a vanity full_name can't masquerade as a role. */}
        <div className="flex items-center justify-end gap-2">
          <span className="text-sm font-semibold text-ink">{user.full_name || user.username}</span>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0',
              roleStyles.bg, roleStyles.fg,
            )}
          >
            {roleLabel(user.role)}
          </span>
        </div>
        <div className="font-num text-[11.5px] text-ink-3">{user.email}</div>
      </div>
      <div
        className="grid h-9 w-9 place-items-center rounded-full bg-brand-soft text-sm font-bold text-brand-text"
        aria-hidden
      >
        {initial}
      </div>
      <Button variant="ghost" size="sm" onClick={() => signOut()} aria-label="התנתק" className="text-ink-2">
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  );
}
