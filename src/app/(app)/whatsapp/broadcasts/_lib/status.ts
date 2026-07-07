// Broadcast (campaign) status presentation + derivation — PURE, no imports, so it
// is safe in client components and unit-testable without a DOM. The single source
// of truth for Hebrew labels, badge tones, cancellability and progress maths used
// across the history table, the details view and the stop dialog.

import type { CampaignStatus, RecipientStatus } from '@/lib/wa-queue/types';

export interface StatusMeta {
  label: string;
  /** Badge classes — tone only (bg + text), padding is applied by the badge. */
  cls: string;
  /** A small dot colour for the badge. */
  dot: string;
}

// Green WhatsApp identity is preserved elsewhere; status badges use a semantic
// palette (blue=in-flight, emerald=done, red=stopped/failed, slate/amber=idle).
export const STATUS_META: Record<CampaignStatus, StatusMeta> = {
  draft:                 { label: 'טיוטה',            cls: 'bg-slate-100 text-slate-600',   dot: 'bg-slate-400' },
  queued:                { label: 'ממתינה לשליחה',    cls: 'bg-amber-50 text-amber-700',    dot: 'bg-amber-500' },
  running:               { label: 'בשליחה',           cls: 'bg-blue-50 text-blue-700',      dot: 'bg-blue-500' },
  paused:                { label: 'מושהית',           cls: 'bg-slate-100 text-slate-600',   dot: 'bg-slate-400' },
  completed:             { label: 'הושלמה',           cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  completed_with_errors: { label: 'הושלמה (עם שגיאות)', cls: 'bg-amber-50 text-amber-700',  dot: 'bg-amber-500' },
  cancelled:             { label: 'נעצרה',            cls: 'bg-red-50 text-red-700',        dot: 'bg-red-500' },
  failed:                { label: 'נכשלה',            cls: 'bg-red-50 text-red-700',        dot: 'bg-red-500' },
};

/** Recipient (delivery-item) status labels for the log. delivered/read are
 *  lifecycle states of an already-sent message, filtered separately. */
export const RECIPIENT_STATUS_META: Record<RecipientStatus, StatusMeta> = {
  pending:    { label: 'ממתין',   cls: 'bg-slate-100 text-slate-600',   dot: 'bg-slate-400' },
  processing: { label: 'בשליחה',  cls: 'bg-blue-50 text-blue-700',      dot: 'bg-blue-500' },
  sent:       { label: 'נשלח',    cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  failed:     { label: 'נכשל',    cls: 'bg-red-50 text-red-700',        dot: 'bg-red-500' },
  skipped:    { label: 'דולג',    cls: 'bg-slate-100 text-slate-600',   dot: 'bg-slate-400' },
  cancelled:  { label: 'בוטל',    cls: 'bg-red-50 text-red-700',        dot: 'bg-red-500' },
};

const TERMINAL: readonly CampaignStatus[] = ['completed', 'completed_with_errors', 'cancelled', 'failed'];
const CANCELLABLE: readonly CampaignStatus[] = ['queued', 'running', 'paused'];

/** A campaign that has finished — no more sending, no stop button, stop polling. */
export function isTerminal(status: CampaignStatus): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

/** Whether the stop action applies — ONLY a queued/sending (or paused) broadcast
 *  can be cancelled. Drives the stop button's visibility everywhere it appears. */
export function isCancellable(status: CampaignStatus): boolean {
  return (CANCELLABLE as readonly string[]).includes(status);
}

export interface ProgressCounts {
  total_count: number;
  pending_count: number;
  processing_count: number;
  sent_count: number;
  failed_count: number;
  cancelled_count: number;
  skipped_count: number;
}

/** Processed = everything that is no longer pending/processing. */
export function processed(c: ProgressCounts): number {
  return Math.max(0, c.total_count - c.pending_count - c.processing_count);
}

/** Whole-percent progress (processed / total), clamped 0..100. */
export function progressPct(c: ProgressCounts): number {
  if (c.total_count <= 0) return 0;
  return Math.min(100, Math.round((processed(c) / c.total_count) * 100));
}

const AUDIENCE_LABELS: Record<string, string> = {
  all: 'כל החייבים',
  owners: 'בעלי נכסים',
  tenants: 'שוכרים',
  debtor_ids: 'רשימה מותאמת',
};

/** Human label for an audience filter (jsonb from the DB). */
export function audienceLabel(audience: unknown): string {
  if (audience && typeof audience === 'object' && 'type' in audience) {
    const t = (audience as { type?: unknown }).type;
    if (typeof t === 'string' && AUDIENCE_LABELS[t]) return AUDIENCE_LABELS[t];
  }
  return '—';
}
