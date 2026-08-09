'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldOff, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function NoAccessCard({ fullName }: { fullName: string | null }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function onLogout() {
    if (leaving) return;
    setLeaving(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
        <ShieldOff className="h-7 w-7" />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold">אין לך הרשאות במערכת</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {fullName ? `שלום ${fullName}, ` : ''}
          החשבון שלך פעיל אך טרם הוגדרו לו הרשאות גישה.
          <br />
          פנה למנהל המערכת כדי לקבל גישה.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onLogout}
        disabled={leaving}
        className="h-11 w-full gap-2 px-4"
      >
        <LogOut className="h-4 w-4" />
        התנתקות
      </Button>
    </div>
  );
}
