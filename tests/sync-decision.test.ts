import { describe, expect, it } from 'vitest';
import {
  SYNC_STAGE_LABELS,
  SyncStageError,
  checkSnapshotFreshness,
  localFreshnessLimitHours,
  stageHttpStatus,
} from '@/lib/sync/decision';
import { secretsMatch } from '@/lib/auth/cronSecret';

describe('checkSnapshotFreshness — (b) a snapshot older than the threshold is stale', () => {
  const NOW = Date.parse('2026-09-11T06:00:00Z');
  it('flags the frozen 25/08 snapshot that was re-copied for 17 days', () => {
    const r = checkSnapshotFreshness('2026-08-25T06:21:05.836+00:00', 36, NOW);
    expect(r.fresh).toBe(false);
    if (!r.fresh) {
      expect(r.message).toContain('הנתון במקור ישן: 2026-08-25T06:21:05.836+00:00');
      expect(Math.round(r.ageHours ?? 0)).toBe(408);
    }
  });
  it('accepts a snapshot inside the window and reports its age', () => {
    const r = checkSnapshotFreshness('2026-09-10T20:00:00Z', 36, NOW);
    expect(r.fresh).toBe(true);
    if (r.fresh) expect(r.ageHours).toBeCloseTo(10, 5);
  });
  it('is exact at the boundary (36h is still fresh, 36h+1s is stale)', () => {
    expect(checkSnapshotFreshness(new Date(NOW - 36 * 36e5).toISOString(), 36, NOW).fresh).toBe(true);
    expect(checkSnapshotFreshness(new Date(NOW - 36 * 36e5 - 1000).toISOString(), 36, NOW).fresh).toBe(false);
  });
  it('treats a missing or unparseable timestamp as stale', () => {
    expect(checkSnapshotFreshness(null, 36, NOW).fresh).toBe(false);
    expect(checkSnapshotFreshness('not-a-date', 36, NOW).fresh).toBe(false);
  });
});

describe('stage → HTTP status and error carrier', () => {
  it('maps upstream failures to 502 and rejected data to 409', () => {
    expect(stageHttpStatus('scrape')).toBe(502);
    expect(stageHttpStatus('pull')).toBe(502);
    expect(stageHttpStatus('stale')).toBe(409);
    expect(stageHttpStatus('guard')).toBe(409);
    // reconcile (27/09/2026) fails AFTER the write — still "data rejected", not "upstream broke".
    expect(stageHttpStatus('reconcile')).toBe(409);
  });
  it('every stage has a Hebrew label for the banner and the history sheet', () => {
    const stages = ['scrape', 'stale', 'guard', 'pull', 'reconcile'] as const;
    for (const st of stages) expect(SYNC_STAGE_LABELS[st].length).toBeGreaterThan(0);
    expect(SYNC_STAGE_LABELS.reconcile).toContain('אחרי הכתיבה');
    // The CRM was torn down on 06/10/2026 — the scrape is billing's own.
    expect(SYNC_STAGE_LABELS.scrape).not.toContain('CRM');
  });
  it('SyncStageError keeps the stage and the source timestamp', () => {
    const e = new SyncStageError('stale', 'x', '2026-08-25T06:21:05Z');
    expect(e).toBeInstanceOf(Error);
    expect(e.stage).toBe('stale');
    expect(e.sourceRunAt).toBe('2026-08-25T06:21:05Z');
  });
});

describe('secretsMatch — constant-time x-cron-secret compare', () => {
  it('matches only the exact secret', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abd', 'abc')).toBe(false);
    expect(secretsMatch('ab', 'abc')).toBe(false);
    expect(secretsMatch('', 'abc')).toBe(false);
  });
});

describe('localFreshnessLimitHours — no default: unset means the caller fails closed', () => {
  it('parses a positive number of hours', () => {
    expect(localFreshnessLimitHours('20')).toBe(20);
    expect(localFreshnessLimitHours('0.5')).toBe(0.5);
  });
  it('unset, empty, zero, negative or non-numeric = null', () => {
    expect(localFreshnessLimitHours(undefined)).toBeNull();
    expect(localFreshnessLimitHours('')).toBeNull();
    expect(localFreshnessLimitHours('0')).toBeNull();
    expect(localFreshnessLimitHours('-3')).toBeNull();
    expect(localFreshnessLimitHours('twenty')).toBeNull();
  });
  it('with the limit, yesterday\'s 05:30 scrape is refused at 06:00 today and today\'s is accepted', () => {
    const now = Date.parse('2026-09-27T03:00:00Z'); // 06:00 Israel
    expect(checkSnapshotFreshness('2026-09-26T02:30:40Z', 20, now).fresh).toBe(false);
    expect(checkSnapshotFreshness('2026-09-27T02:30:40Z', 20, now).fresh).toBe(true);
  });
});
