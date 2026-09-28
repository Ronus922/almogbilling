'use client';

import { usePathname, useSearchParams } from 'next/navigation';

// Where a portal link goes: the same page the portal is mounted on. On
// /portal that is simply `/portal?…`; in the admin preview (/finance?view=
// resident&apt=…) the mount page and its `view` / `apt` are carried along so
// a tab or month switch stays inside the preview. Every navigation of the
// portal screens builds its URL here — none hard-codes /portal.
const CARRIED = ['view', 'apt'] as const;

export function usePortalHref(): (params: Record<string, string | null | undefined>) => string {
  const pathname = usePathname();
  const sp = useSearchParams();
  return (params) => {
    const q = new URLSearchParams();
    for (const k of CARRIED) {
      const v = sp.get(k);
      if (v) q.set(k, v);
    }
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined || v === '') q.delete(k);
      else q.set(k, v);
    }
    const qs = q.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };
}
