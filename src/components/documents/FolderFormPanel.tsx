'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, FolderPlus, Folder } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { MAX_FOLDER_NAME_LEN } from '@/lib/constants/documents';
import { documentErrorMessage } from './helpers';

interface Props {
  open: boolean;
  /** Rename target — when present the panel renames; otherwise it creates. */
  folder?: { id: string; name: string } | null;
  /** Parent for a newly-created folder (null = root). Ignored on rename. */
  parentFolderId?: string | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

export function FolderFormPanel({
  open,
  folder = null,
  parentFolderId = null,
  onOpenChange,
  onSaved,
}: Props) {
  const isRename = !!folder;
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(folder?.name ?? '');
      setTouched(false);
      setSubmitting(false);
    }
  }, [open, folder]);

  const trimmed = name.trim();
  const error = touched && !trimmed ? 'יש להזין שם תיקייה' : null;
  const canSubmit = !!trimmed && trimmed.length <= MAX_FOLDER_NAME_LEN && !submitting;

  useEscapeKey(open, () => requestClose());

  function requestClose() {
    if (submitting) return;
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTouched(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = isRename
        ? await fetch(`/api/documents/folders/${folder!.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name: trimmed }),
          })
        : await fetch('/api/documents/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name: trimmed, parent_folder_id: parentFolderId }),
          });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(documentErrorMessage(data.error));

      toast.success(isRename ? 'שם התיקייה עודכן' : 'התיקייה נוצרה');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">
                {isRename ? 'שינוי שם תיקייה' : 'תיקייה חדשה'}
              </SheetTitle>
              <p className="mt-1 text-sm text-white/70">
                {isRename ? 'עדכן את שם התיקייה.' : 'תן שם לתיקייה. ניתן לקנן תיקיות זו בתוך זו.'}
              </p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              disabled={submitting}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="פרטי התיקייה" icon={isRename ? Folder : FolderPlus} iconTone="amber">
            <div className="space-y-2 py-2">
              <Label htmlFor="folder-name" className="text-base font-medium text-muted-foreground">
                שם התיקייה
                <span className="text-red-500"> *</span>
              </Label>
              <Input
                id="folder-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                disabled={submitting}
                autoFocus
                placeholder="לדוגמה: חוזים, אישורים, תוכניות"
                className={cn('h-10', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
              />
              {error && (
                <p className="text-[12px] font-semibold text-red-500 text-right">⚠️ {error}</p>
              )}
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={handleSubmit}
          saveDisabled={!canSubmit}
          saveLabel={submitting ? 'שומר…' : isRename ? 'שמור שינויים' : 'צור תיקייה'}
        />
      </SheetContent>
    </Sheet>
  );
}
