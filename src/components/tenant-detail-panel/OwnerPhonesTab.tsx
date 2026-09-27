'use client';

// "בעלי דירה" tab — the portal roster of this apartment: who may sign in to
// /portal on its behalf. Add / rename / deactivate. A number is never DELETED,
// only switched off: the login log keeps pointing at it, and a former owner's
// history has to stay readable (the same principle as "a flat is never deleted").
//
// Add / edit open a Sheet, not a Dialog (DESIGN.md §12): every create/edit on an
// entity is a side panel, however small the form.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { formatPhoneDisplay } from '@/lib/phone';
import { e164ToLocal } from '@/lib/portal/phone';
import type { OwnerPhone } from '@/lib/types/portal';
import { Section } from './Section';
import { OwnerPhoneSheet } from '@/components/portal/OwnerPhoneSheet';

export function OwnerPhonesTab({ apartmentNumber, canEdit }: {
  apartmentNumber: string;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<OwnerPhone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<OwnerPhone | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/apartments/${encodeURIComponent(apartmentNumber)}/owner-phones`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: OwnerPhone[] };
      setItems(data.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [apartmentNumber]);

  useEffect(() => { void load(); }, [load]);

  async function toggleActive(row: OwnerPhone, next: boolean) {
    setSavingId(row.id);
    // Optimistic, with rollback — the same contract as the publish toggle.
    setItems((cur) => cur?.map((x) => (x.id === row.id ? { ...x, is_active: next } : x)) ?? cur);
    try {
      const res = await fetch(`/api/apartments/${encodeURIComponent(apartmentNumber)}/owner-phones`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: row.id, is_active: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success(next ? 'המספר הופעל' : 'המספר הושבת');
    } catch (err) {
      setItems((cur) => cur?.map((x) => (x.id === row.id ? { ...x, is_active: !next } : x)) ?? cur);
      toast.error(`השמירה נכשלה: ${(err as Error).message}`);
    } finally {
      setSavingId(null);
    }
  }

  const activeCount = items?.filter((x) => x.is_active).length ?? 0;

  return (
    <>
      <Section
        title="בעלי דירה"
        icon={Users}
        iconTone="blue"
        subtitle={items ? `${activeCount} מתוך ${items.length} מספרים פעילים לכניסה לפורטל` : undefined}
        headerSlot={
          canEdit ? (
            <Button
              type="button"
              size="sm"
              onClick={() => { setEditing(null); setSheetOpen(true); }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" aria-hidden />
              הוסף בעלים
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            שגיאה בטעינת בעלי הדירה: {error}
          </div>
        ) : !items ? (
          <div className="space-y-2 py-2">
            <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
            <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-2 text-center text-xs text-slate-400">
            אין מספרי בעלים לדירה הזו — בלי מספר, אף אחד לא יכול להיכנס לפורטל.
          </p>
        ) : (
          <ul className="space-y-2 pb-1">
            {items.map((row) => (
              <li
                key={row.id}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3',
                  row.is_active ? 'border-line bg-white' : 'border-slate-200 bg-slate-50',
                )}
              >
                <div className="min-w-0">
                  <p className={cn('truncate text-sm font-semibold', row.is_active ? 'text-slate-900' : 'text-slate-500')}>
                    {row.owner_name ?? '—'}
                  </p>
                  <p className="font-num text-sm tabular-nums text-slate-600" dir="ltr">
                    {formatPhoneDisplay(e164ToLocal(row.phone_e164)) ?? row.phone_e164}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canEdit && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => { setEditing(row); setSheetOpen(true); }}
                    >
                      עריכה
                    </Button>
                  )}
                  <label className="flex h-11 cursor-pointer items-center gap-2 px-1 text-xs font-semibold text-slate-600">
                    <Switch
                      checked={row.is_active}
                      onCheckedChange={(v) => toggleActive(row, v === true)}
                      disabled={!canEdit || savingId === row.id}
                      aria-label={row.is_active ? 'פעיל' : 'לא פעיל'}
                    />
                    <span className={row.is_active ? 'text-emerald-700' : 'text-slate-500'}>
                      {row.is_active ? 'פעיל' : 'לא פעיל'}
                    </span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <OwnerPhoneSheet
        open={sheetOpen}
        apartmentNumber={apartmentNumber}
        row={editing}
        onOpenChange={setSheetOpen}
        onSaved={() => { setSheetOpen(false); void load(); }}
      />
    </>
  );
}
