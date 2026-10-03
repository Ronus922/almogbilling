'use client';

// /admin/portal-blocked — the phones the portal containment blocks: a phone
// whose active apartments are recorded under different people sees no
// financial data (lib/portal/ownership.ts). Each card shows the apartments and
// the names behind the phone, so the admin can either unify the name on the
// apartment card (same person, different spelling) or detach the wrong link
// here. Nothing else is editable on this screen.

import { useCallback, useEffect, useState } from 'react';
import { PhoneOff } from 'lucide-react';
import type { BlockedPortalPhone } from '@/lib/types/portal';
import { OWNER_PHONE_SOURCE_LABEL, rosterPhoneDisplay } from '@/lib/portal/rosterLabels';
import { DetachLinkButton } from './DetachLinkButton';

export function AdminPortalBlockedClient({ canEdit }: { canEdit: boolean }) {
  const [phones, setPhones] = useState<BlockedPortalPhone[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/portal-blocked', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { phones: BlockedPortalPhone[] };
      setPhones(data.phones);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">טלפונים חסומים</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            טלפון שמשויך לדירות של אנשים שונים לא רואה נתונים כספיים בפורטל. אם זה אותו אדם —
            אחדו את השם ברשומת הבעלים של הדירה; אם השיוך שגוי — נתקו אותו כאן.
          </p>
        </div>
        <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-2">
          <PhoneOff className="h-4 w-4 text-amber-600" aria-hidden />
          {phones ? `${phones.length} טלפונים` : '—'}
        </span>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          שגיאה בטעינת הרשימה: {error}
        </div>
      ) : !phones ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      ) : phones.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          אין טלפונים חסומים — כל טלפון בפורטל משויך לדירות של אדם אחד.
        </div>
      ) : (
        <ul className="space-y-3">
          {phones.map((p) => (
            <li key={p.phone_e164} className="rounded-2xl border border-line bg-white p-4 shadow-soft-xs">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-3">
                <span dir="ltr" className="font-num text-base font-bold tabular-nums text-slate-900">
                  {rosterPhoneDisplay(p.phone_e164)}
                </span>
                <span className="text-sm text-slate-500">{p.links.length} דירות</span>
              </div>
              <ul className="space-y-2">
                {p.links.map((l) => (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-900">
                        דירה <span className="font-num">{l.apartment_number}</span>
                        <span className="font-normal text-slate-700"> · {l.owner_name ?? 'בלי שם'}</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        מקור: {l.source_table ? OWNER_PHONE_SOURCE_LABEL[l.source_table] : 'אין רשומה'}
                      </p>
                    </div>
                    {canEdit && (
                      <DetachLinkButton
                        id={l.id}
                        apartmentNumber={l.apartment_number}
                        phoneE164={p.phone_e164}
                        ownerName={l.owner_name}
                        onDetached={() => void load()}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
