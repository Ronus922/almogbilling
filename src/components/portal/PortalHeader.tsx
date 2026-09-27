'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

// The portal's only chrome: the building name and a way out. No nav, no search,
// no bell — a resident has exactly one screen. `h-16` + `border-b` mirrors the
// staff Header (DESIGN.md §32) so the two feel like one product.

export function PortalHeader() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    if (leaving) return;
    setLeaving(true);
    try {
      await fetch('/api/portal/logout', { method: 'POST', credentials: 'include' });
      startTransition(() => router.replace('/portal/login'));
    } catch {
      toast.error('היציאה נכשלה');
      setLeaving(false);
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-gradient-to-br from-brand to-brand-dark text-white">
            <Building2 className="h-[22px] w-[22px]" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-extrabold leading-tight text-ink sm:text-lg">
              מגדלי חוף הכרמל
            </span>
            <span className="block truncate text-xs text-ink-3">בניין אלמוג</span>
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={logout}
          disabled={leaving || pending}
          className="shrink-0 gap-2"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">יציאה</span>
        </Button>
      </div>
    </header>
  );
}
