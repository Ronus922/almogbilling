'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Eye, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The strip above the admin's preview of the owners portal
// (/finance?view=resident): says what this is, lets the admin pick which
// apartment's "החשבון שלי" to look at, and leads back to /finance. Lives
// OUTSIDE the portal skin and only on the staff route — the portal itself has
// no apartment picker and no way to reach this.
export function AdminPreviewBar({ apartments, selected }: {
  /** Every apartment number of the building, in table order. */
  apartments: string[];
  /** The `apt` in the URL, or null = none picked. */
  selected: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  function pick(apt: string) {
    const q = new URLSearchParams(sp.toString());
    if (apt) q.set('apt', apt); else q.delete('apt');
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
  }

  function exit() {
    const q = new URLSearchParams(sp.toString());
    // Back to the admin screen: drop the preview keys and the portal-only ones.
    for (const k of ['view', 'apt', 'r', 'n', 'f']) q.delete(k);
    const t = q.get('tab');
    if (t && t !== 'fund') q.delete('tab');
    const qs = q.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  return (
    <div role="status" className={cn('mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900', pending && 'opacity-70')}>
      <span className="flex items-center gap-2 font-semibold">
        <Eye className="h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
        תצוגה מקדימה — כך רואה דייר
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          דירה
          <select
            value={selected ?? ''}
            onChange={(e) => pick(e.target.value)}
            disabled={pending}
            aria-label="דירה לתצוגה מקדימה"
            className="h-10 rounded-[10px] border border-line bg-white px-3 font-num text-sm tabular-nums text-ink"
          >
            <option value="">— בחר דירה —</option>
            {apartments.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" onClick={exit} disabled={pending} className="gap-2">
          <LogOut className="h-4 w-4" aria-hidden /> יציאה מתצוגת דייר
        </Button>
      </div>
    </div>
  );
}
