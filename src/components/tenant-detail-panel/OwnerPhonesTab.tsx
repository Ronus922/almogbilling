'use client';

// "בעלי דירה" tab → "טלפון ← דירות בפורטל": which phones open this apartment
// in the owners portal, which owner record links each one, and what ELSE the
// same phone opens. View and detach only (decision 5 of the 03/10/2026 audit):
// the roster mirrors the apartment's owner records (migration 20261003095149),
// so a phone is added — or brought back — by typing it into the owner record
// on the "פרטי דייר" tab, never here. A row is never deleted: detached and
// former phones stay listed, greyed, with the reason.

import { useCallback, useEffect, useState } from 'react';
import { Smartphone, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OwnerPhone } from '@/lib/types/portal';
import {
  OWNER_PHONE_SOURCE_LABEL, ownerPhoneOffLabel, rosterPhoneDisplay,
} from '@/lib/portal/rosterLabels';
import { DetachLinkButton } from '@/components/portal/DetachLinkButton';
import { Section } from './Section';

export function OwnerPhonesTab({ apartmentNumber, canEdit }: {
  apartmentNumber: string;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<OwnerPhone[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/apartments/${encodeURIComponent(apartmentNumber)}/owner-phones`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: OwnerPhone[] };
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [apartmentNumber]);

  useEffect(() => { void load(); }, [load]);

  const activeCount = items?.filter((x) => x.is_active).length ?? 0;

  return (
    <Section
      title="טלפון ← דירות בפורטל"
      icon={Smartphone}
      iconTone="blue"
      subtitle={items ? `${activeCount} מתוך ${items.length} טלפונים פותחים את הדירה בפורטל` : undefined}
    >
      <p className="pb-3 text-[13px] leading-relaxed text-slate-500">
        טלפון נכנס לפורטל רק כשהוא רשום ברשומת הבעלים של הדירה (בעלים או איש קשר בעלים).
        {'להוספה — רושמים אותו ברשומת הבעלים בטאב "פרטי דייר".'}
      </p>
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          שגיאה בטעינת הטלפונים: {error}
        </div>
      ) : !items ? (
        <div className="space-y-2 py-2">
          <div className="h-20 animate-pulse rounded-lg bg-muted/60" />
          <div className="h-20 animate-pulse rounded-lg bg-muted/60" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-center text-xs text-slate-400">
          אין טלפון שפותח את הדירה בפורטל — אין ברשומת הבעלים נייד תקין.
        </p>
      ) : (
        <ul className="space-y-2 pb-1">
          {items.map((row) => (
            <li
              key={row.id}
              className={cn(
                'flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3',
                row.is_active ? 'border-line bg-white' : 'border-slate-200 bg-slate-50',
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    dir="ltr"
                    className={cn('font-num text-sm font-semibold tabular-nums', row.is_active ? 'text-slate-900' : 'text-slate-500')}
                  >
                    {rosterPhoneDisplay(row.phone_e164)}
                  </span>
                  <span className={cn('truncate text-sm', row.is_active ? 'text-slate-700' : 'text-slate-500')}>
                    {row.source_name ?? row.owner_name ?? '—'}
                  </span>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                      row.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600',
                    )}
                  >
                    {row.is_active ? 'פעיל בפורטל' : ownerPhoneOffLabel(row.detach_reason)}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  מקור: {row.source_table ? OWNER_PHONE_SOURCE_LABEL[row.source_table] : 'אין רשומה'}
                </p>
                {row.other_apartments.length > 0 && (
                  <p className="text-xs text-slate-500">
                    הטלפון פותח גם את דירות{' '}
                    <span className="font-num font-semibold text-slate-700">{row.other_apartments.join(' · ')}</span>
                  </p>
                )}
                {row.is_active && row.mixed_owners && (
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    חסום לנתונים כספיים: הדירות של הטלפון רשומות על שמות שונים
                  </p>
                )}
              </div>
              {canEdit && row.is_active && (
                <DetachLinkButton
                  id={row.id}
                  apartmentNumber={apartmentNumber}
                  phoneE164={row.phone_e164}
                  ownerName={row.source_name ?? row.owner_name}
                  onDetached={() => void load()}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
