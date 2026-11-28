'use client';

// The three notes of a chip order on screen (27/11/2026, Ronen) — notes.ts
// says who writes which. Three pieces, shared by every screen that shows a
// note, so a note always carries the same label:
//   · ChipOrderNotesIcon — a small note icon for a table row or a phone card:
//     the notes open on hover and on a tap (a popover, never a wide column).
//   · ChipNoteBlock — one note in full, read only, with its label (the order
//     window, the guard's order card, the reception window's line).
//   · DeliveryNoteField — the optional "הערת מסירה" box of a hand-over: the
//     guard's "נמסר" and the staff's "נאסף".
// Plain text only: React escapes it, and `whitespace-pre-wrap` keeps the
// writer's line breaks.

import { StickyNote } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { CHIP_NOTE_MAX, DELIVERY_NOTE_LABEL, GUARD_NOTE_LABEL, ORDERER_NOTE_LABEL } from '@/lib/chipOrders/notes';

const WHEN = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** "רונן · 27/11/26, 14:05" — who wrote a note and when, when known. */
export function noteMeta(by: string | null | undefined, at: string | null | undefined): string | null {
  const parts = [by?.trim() || null, at ? WHEN.format(new Date(at)) : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface ChipOrderNotesValue {
  orderer_note?: string | null;
  guard_note?: string | null;
  delivery_note?: string | null;
  delivery_note_by_name?: string | null;
  delivery_note_at?: string | null;
}

/** The notes an order has, in their fixed order, with their labels. */
function notesOf(v: ChipOrderNotesValue): { key: string; label: string; text: string; meta: string | null }[] {
  const out: { key: string; label: string; text: string; meta: string | null }[] = [];
  if (v.orderer_note) out.push({ key: 'orderer', label: ORDERER_NOTE_LABEL, text: v.orderer_note, meta: null });
  if (v.guard_note) out.push({ key: 'guard', label: GUARD_NOTE_LABEL, text: v.guard_note, meta: null });
  if (v.delivery_note) out.push({ key: 'delivery', label: DELIVERY_NOTE_LABEL, text: v.delivery_note, meta: noteMeta(v.delivery_note_by_name, v.delivery_note_at) });
  return out;
}

/** One note in full, read only. */
export function ChipNoteBlock({
  label, text, meta, testId, className,
}: { label: string; text: string; meta?: string | null; testId?: string; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 p-3', className)} data-testid={testId}>
      <span className="text-[13px] font-bold text-amber-900">
        {label}
        {meta && <span className="ms-2 font-semibold text-amber-800/80">{meta}</span>}
      </span>
      <p className="whitespace-pre-wrap text-[14px] font-medium leading-relaxed text-slate-800 [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

/**
 * The note icon of a row: nothing when the order has no note; otherwise a
 * 44px target whose popover lists every note of the order with its label
 * (on hover, and on a tap / click — the row's own click is not triggered).
 */
export function ChipOrderNotesIcon({ notes, testId = 'chip-order-notes' }: { notes: ChipOrderNotesValue; testId?: string }) {
  const list = notesOf(notes);
  if (list.length === 0) return null;
  const label = `הערות להזמנה: ${list.map((n) => n.label).join(', ')}`;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={label}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
        className="-m-[13px] inline-grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[10px] text-amber-600 hover:text-amber-700 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[var(--chip-brand)]"
      >
        <StickyNote className="h-[18px] w-[18px]" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        dir="rtl"
        side="bottom"
        align="start"
        className="flex w-[320px] flex-col gap-2 p-3"
        data-testid={`${testId}-popup`}
        onClick={(e) => e.stopPropagation()}
      >
        {list.map((n) => (
          <ChipNoteBlock key={n.key} label={n.label} text={n.text} meta={n.meta} testId={`${testId}-${n.key}`} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The optional delivery note of a hand-over (2–3 lines). */
export function DeliveryNoteField({
  value, onChange, disabled = false, testId = 'delivery-note',
}: { value: string; onChange: (v: string) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-slate-800">
        {DELIVERY_NOTE_LABEL} <span className="font-semibold text-slate-500">(לא חובה)</span>
      </span>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={3}
        maxLength={CHIP_NOTE_MAX}
        placeholder="למשל: מי קיבל בפועל את הצ׳יפים"
        className="min-h-[76px] px-3 py-2 text-base sm:text-sm"
        data-testid={testId}
      />
      <span className="self-end text-[12px] font-medium text-slate-500" aria-live="polite">{value.length}/{CHIP_NOTE_MAX}</span>
    </label>
  );
}
