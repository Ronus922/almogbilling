'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { StatusAdminRow } from '@/lib/db/statuses';

export function DeleteStatusDialog({
  target,
  onOpenChange,
  onDeleted,
}: {
  target: StatusAdminRow | null;
  onOpenChange: (v: boolean) => void;
  onDeleted: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const open = target !== null;
  const linkedCount = target?.linked_count ?? 0;
  const hasLinked = linkedCount > 0;

  async function confirmDelete() {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/statuses/${target.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.message || `מחיקה נכשלה: HTTP ${res.status}`);
        return;
      }
      toast.success('הסטטוס נמחק');
      await onDeleted();
    } catch (err) {
      toast.error(`מחיקה נכשלה: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) onOpenChange(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {hasLinked ? 'לא ניתן למחוק את הסטטוס' : 'מחיקת סטטוס'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {hasLinked ? (
              <>
                הסטטוס{' '}
                <strong className="font-semibold text-slate-900">
                  &quot;{target?.name ?? ''}&quot;
                </strong>{' '}
                משויך ל-
                <span className="tabular-nums">{linkedCount}</span> דיירים. שייך אותם
                לסטטוס אחר תחילה דרך עמודת המקושרים, ואז נסה שוב.
              </>
            ) : (
              <>
                האם למחוק את הסטטוס{' '}
                <strong className="font-semibold text-slate-900">
                  &quot;{target?.name ?? ''}&quot;
                </strong>
                ? פעולה זו אינה ניתנת לביטול.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {hasLinked ? (
            <AlertDialogCancel>סגור</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={busy}>ביטול</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={busy}
                className="gap-2 bg-destructive text-white hover:bg-destructive/90"
              >
                <Trash2 className="h-4 w-4" />
                {busy ? 'מוחק…' : 'מחק'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
