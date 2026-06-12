'use client';

import { useAuth } from '@/lib/auth/context';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const initial = (user.full_name || user.username).charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3">
      <div className="text-end leading-tight">
        <div className="text-sm font-semibold text-ink">{user.full_name || user.username}</div>
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
