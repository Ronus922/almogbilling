'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Eye } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

// "תצוגת דייר" — the admin previews /finance exactly as a resident will get
// it. The mode lives in the URL (`?view=resident`, alongside `tab` and `m`),
// so the server renders the resident data set and nothing of the admin's.

export function useResidentViewNav() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  function set(active: boolean) {
    const q = new URLSearchParams(sp.toString());
    if (active) q.set('view', 'resident'); else q.delete('view');
    const qs = q.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }
  return { set, pending };
}

export function ResidentViewToggle({ active }: { active: boolean }) {
  const { set, pending } = useResidentViewNav();
  return (
    <label
      className={cn(
        'flex h-11 cursor-pointer select-none items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-colors',
        active ? 'border-indigo-200 bg-indigo-50 text-indigo-800' : 'border-line bg-white text-ink-2 hover:bg-row-hover',
        pending && 'opacity-70',
      )}
    >
      <Switch checked={active} onCheckedChange={set} disabled={pending} aria-label="תצוגת דייר" />
      <Eye className="h-4 w-4" aria-hidden />
      תצוגת דייר
    </label>
  );
}
