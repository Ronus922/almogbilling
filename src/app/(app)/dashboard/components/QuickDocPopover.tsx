'use client';

import { useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { MessageSquare, Send, Loader2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  debtorId: string;
  apartment: string;
  owner: string | null;
  /** contacts:edit — gates the whole action (viewer sees a disabled icon). */
  canEdit: boolean;
}

// Quick-documentation popover anchored to the comment icon in the dashboard
// table's actions column. A free-text note/summary — channels (email / WhatsApp /
// SMS) are documented automatically when sent from the system, so there's no
// channel/outcome field here. Posts to the existing comments endpoint and shows
// up in the unified timeline as "הערה". Opens WITHOUT entering the debtor panel.
export function QuickDocPopover({ debtorId, apartment, owner, canEdit }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  // Viewer (no edit permission) — disabled icon, no popover.
  if (!canEdit) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <button
            type="button"
            disabled
            aria-label="תיעוד מהיר"
            className="inline-flex items-center justify-center text-blue-300 transition-colors disabled:cursor-default"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>אין הרשאה</TooltipContent>
      </Tooltip>
    );
  }

  function handleOpenChange(next: boolean) {
    if (saving) return;
    setOpen(next);
    // ESC / outside-click close → discard quietly (quick-doc, no exit confirm).
    if (!next) setText('');
  }

  const canSave = text.trim().length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/debtors/${debtorId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content: text.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success('התיעוד נשמר');
      setOpen(false);
      setText('');
      router.refresh();
    } catch (err) {
      toast.error(`שמירה נכשלה: ${err instanceof Error ? err.message : 'שגיאה'}`);
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* Active blue icon + "תיעוד מהיר" tooltip. Tooltip wraps the Popover
          trigger so a single button is both the anchor and the hover target. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label="תיעוד מהיר"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center justify-center text-blue-600 transition-colors hover:text-blue-700"
            />
          }
        >
          <MessageSquare className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>תיעוד מהיר</TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="end"
        dir="rtl"
        className="w-[380px] overflow-hidden p-0"
        // Defensive: clicks inside the popover never bubble to the table row.
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — site panel style: gradient + icon-chip + title + X */}
        <div className="flex items-start justify-between gap-3 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-4 py-3.5 text-white">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10">
              <MessageSquare className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h4 className="truncate text-base font-bold leading-tight">תיעוד לדירה {apartment}</h4>
              <p className="truncate text-xs text-white/60">{owner ?? 'ללא שם'}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            aria-label="סגור"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-2 bg-white px-4 py-4">
          <h5 className="text-sm font-bold text-slate-900">הוסף תיעוד חדש</h5>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="כתוב סיכום / תיעוד..."
            rows={4}
            className="resize-none"
            disabled={saving}
            autoFocus
          />
          <p className="text-xs text-slate-400 text-start">
            לחץ <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Ctrl+Enter</kbd> לשליחה מהירה
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-start gap-2 border-t border-slate-100 bg-white px-4 py-3">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!canSave}
            className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {saving ? 'שומר…' : 'הוסף תיעוד'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={saving}
          >
            סגור
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
