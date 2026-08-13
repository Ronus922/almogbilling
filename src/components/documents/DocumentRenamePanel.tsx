'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, FileText } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { MAX_FILE_NAME_LEN } from '@/lib/constants/documents';
import { documentErrorMessage } from './helpers';

interface Props {
  open: boolean;
  doc: { id: string; name: string } | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

export function DocumentRenamePanel({ open, doc, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(doc?.name ?? '');
      setTouched(false);
      setSubmitting(false);
    }
  }, [open, doc]);

  const trimmed = name.trim();
  const error = touched && !trimmed ? 'יש להזין שם קובץ' : null;
  const canSubmit = !!trimmed && trimmed.length <= MAX_FILE_NAME_LEN && !submitting;

  useEscapeKey(open, () => requestClose());

  function requestClose() {
    if (submitting) return;
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit || !doc) {
      setTouched(true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ file_name: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(documentErrorMessage(data.error));

      toast.success('שם הקובץ עודכן');
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
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">שינוי שם קובץ</SheetTitle>
              <p className="mt-1 text-sm text-white/70">עדכן את שם הקובץ המוצג. הקובץ עצמו לא משתנה.</p>
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
          <Section title="פרטי הקובץ" icon={FileText} iconTone="blue">
            <div className="space-y-2 py-2">
              <Label htmlFor="doc-name" className="text-base font-medium text-muted-foreground">
                שם הקובץ
                <span className="text-red-500"> *</span>
              </Label>
              <Input
                id="doc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                disabled={submitting}
                autoFocus
                className={cn('h-10', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
              />
              {error && (
                <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {error}</p>
              )}
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={handleSubmit}
          saveDisabled={!canSubmit}
          saveLabel={submitting ? 'שומר…' : 'שמור שינויים'}
        />
      </SheetContent>
    </Sheet>
  );
}
