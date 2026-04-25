'use client';

import { useAuth } from '@/lib/auth/context';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const initial = (user.full_name || user.username).charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3">
      <div className="text-sm leading-tight text-end">
        <div className="font-medium">{user.full_name || user.username}</div>
        <div className="text-xs text-muted-foreground">{user.email}</div>
      </div>
      <div
        className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary text-sm font-semibold"
        aria-hidden
      >
        {initial}
      </div>
      <Button variant="ghost" size="sm" onClick={() => signOut()} aria-label="התנתק">
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  );
}
