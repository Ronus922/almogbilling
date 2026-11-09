'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import type { VisitorScan } from '@/lib/visitors/model';
import { CropEditor } from './CropEditor';
import { fullName } from './format';

// "חתוך מחדש" (admin / super admin, 09/11/2026): the STORED photo of a scan, cropped
// again with the same editor the guard used. The frame starts as the whole picture, so
// pressing the button changes nothing until someone moves an edge. Only the stored,
// already-cropped photo exists (the camera original is never kept), so this can cut
// more away but cannot bring anything back — hence the confirmation before it replaces
// the photo, and the audit row the server writes.
//
// A Dialog, rendered INSIDE the detail sheet's tree (like ImageViewer): it edits one
// thing — the picture — and a modal sheet makes everything outside itself inert, so a
// sibling overlay would be unreachable.

interface Props {
  open: boolean;
  scan: VisitorScan;
  onClose: () => void;
  onReplaced: (scan: VisitorScan) => void;
}

export function RecropDialog({ open, scan, onClose, onReplaced }: Props) {
  const [pending, setPending] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);

  useEscapeKey(open && pending === null, onClose);
  useEscapeKey(open && pending !== null && !saving, () => setPending(null));

  async function replace() {
    if (!pending) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('image', pending, 'recrop.jpg');
      const r = await fetch(`/api/visitors/${scan.id}/image`, { method: 'POST', body: fd, credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string; scan?: VisitorScan; old_photo_removed?: boolean };
      if (!r.ok || !data.scan) throw new Error(data.error ?? 'החלפת הצילום נכשלה');
      if (data.old_photo_removed === false) {
        // The row now points at the new photo, but Storage refused to drop the old one (an ID
        // document). Say so — its key is in the audit row for a manual removal.
        toast.warning('הצילום הוחלף, אבל הצילום הישן לא נמחק מהאחסון — דווח למנהל המערכת', { duration: 12000 });
      } else {
        toast.success('הצילום הוחלף');
      }
      setPending(null);
      onReplaced(data.scan);
    } catch (e) {
      toast.error((e as Error).message);
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        dir="rtl"
        className="top-0 start-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-white p-0 ring-0 sm:max-w-none rtl:translate-x-0"
      >
        <div className="flex flex-none items-start justify-between gap-4 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] text-white">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-2xl font-bold text-white">חיתוך מחדש של הצילום</DialogTitle>
            <p className="mt-1 break-words text-sm text-white/70">{fullName(scan)} · הצילום השמור יוחלף בגרסה החתוכה.</p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="סגור" disabled={saving} data-recrop-close
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {open && (
          <CropEditor
            key={scan.image_url} src={scan.image_url} initial="full"
            confirmLabel="החלף תמונה" cancelLabel="ביטול" busy={saving}
            onConfirm={setPending} onCancel={onClose}
            onLoadError={() => { toast.error('לא ניתן לטעון את הצילום'); onClose(); }}
          />
        )}

        <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !saving) setPending(null); }}>
          <AlertDialogContent dir="rtl">
            <AlertDialogHeader>
              <AlertDialogTitle>להחליף את הצילום השמור?</AlertDialogTitle>
              <AlertDialogDescription>
                הצילום הנוכחי יוחלף בגרסה החתוכה, והחלק שנחתך לא יישמר. אי אפשר לשחזר.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>ביטול</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void replace(); }} disabled={saving} data-recrop-confirm
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                {saving ? 'מחליף…' : 'החלף תמונה'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
