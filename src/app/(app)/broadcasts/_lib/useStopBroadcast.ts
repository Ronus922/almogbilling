'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { Campaign } from '@/lib/wa-queue/types';
import type { StopCounts } from '../_components/StopBroadcastDialog';

// Shared stop flow for the history table AND the details view. Opens the confirm
// dialog for a target campaign, POSTs the real server-side cancel, and reports the
// updated campaign back so the caller can refresh. The request is idempotent
// server-side, so a double-click can never corrupt the counters; the button is
// disabled while `pending`.
export function useStopBroadcast(onStopped?: (updated: Campaign) => void) {
  const [target, setTarget] = useState<Campaign | null>(null);
  const [pending, setPending] = useState(false);

  const counts: StopCounts | null = target
    ? {
        sent: target.sent_count,
        failed: target.failed_count,
        remaining: target.pending_count + target.processing_count,
        total: target.total_count,
      }
    : null;

  function request(campaign: Campaign) { setTarget(campaign); }
  function close() { if (!pending) setTarget(null); }

  async function confirm() {
    if (!target || pending) return;
    setPending(true);
    try {
      const r = await fetch(`/api/whatsapp/campaigns/${target.id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'cancel' }),
      });
      const data = (await r.json().catch(() => ({}))) as Campaign & { error?: string };
      if (!r.ok) throw new Error(data.error || `עצירת התפוצה נכשלה (HTTP ${r.status})`);
      toast.success(
        `התפוצה נעצרה — ${data.sent_count} נשלחו, ${data.failed_count} נכשלו, ${data.cancelled_count} בוטלו לפני שליחה.`,
      );
      onStopped?.(data);
      setTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'עצירת התפוצה נכשלה');
    } finally {
      setPending(false);
    }
  }

  return { target, counts, pending, request, close, confirm };
}
