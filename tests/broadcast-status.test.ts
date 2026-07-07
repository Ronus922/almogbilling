import { describe, expect, it } from 'vitest';
import {
  isCancellable, isTerminal, progressPct, processed, audienceLabel, STATUS_META,
} from '@/app/(app)/whatsapp/broadcasts/_lib/status';
import type { CampaignStatus } from '@/lib/wa-queue/types';

// The pure UI logic behind the broadcast screens — the same predicates that decide
// when the Stop button renders and how progress reads. No DOM needed.

const ALL: CampaignStatus[] = [
  'draft', 'queued', 'running', 'paused', 'completed',
  'completed_with_errors', 'cancelled', 'failed',
];

describe('broadcast status logic', () => {
  it('stop button shows ONLY for queued / running / paused', () => {
    expect(ALL.filter(isCancellable).sort()).toEqual(['paused', 'queued', 'running']);
    // The terminal + draft states must never offer a stop.
    for (const s of ['draft', 'completed', 'completed_with_errors', 'cancelled', 'failed'] as CampaignStatus[]) {
      expect(isCancellable(s)).toBe(false);
    }
  });

  it('terminal states stop polling; active states keep polling', () => {
    expect(ALL.filter(isTerminal).sort()).toEqual(['cancelled', 'completed', 'completed_with_errors', 'failed']);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('queued')).toBe(false);
  });

  it('every status has a Hebrew label + tone', () => {
    for (const s of ALL) {
      expect(STATUS_META[s].label.length).toBeGreaterThan(0);
      expect(STATUS_META[s].cls).toContain('text-');
    }
  });

  it('progress = processed / total, clamped', () => {
    const c = { total_count: 165, pending_count: 80, processing_count: 3, sent_count: 79, failed_count: 3, cancelled_count: 0, skipped_count: 0 };
    expect(processed(c)).toBe(82);          // 165 - 80 - 3
    expect(progressPct(c)).toBe(50);        // round(82/165*100)
    expect(progressPct({ ...c, total_count: 0 })).toBe(0);   // no divide-by-zero
    expect(progressPct({ ...c, pending_count: 0, processing_count: 0 })).toBe(100);
  });

  it('audience labels map known types, fall back otherwise', () => {
    expect(audienceLabel({ type: 'all' })).toBe('כל החייבים');
    expect(audienceLabel({ type: 'owners' })).toBe('בעלי נכסים');
    expect(audienceLabel({ type: 'tenants' })).toBe('שוכרים');
    expect(audienceLabel({ type: 'debtor_ids' })).toBe('רשימה מותאמת');
    expect(audienceLabel(null)).toBe('—');
    expect(audienceLabel({})).toBe('—');
  });
});
