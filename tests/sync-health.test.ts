import { describe, expect, it } from 'vitest';
import { computeSyncHealth, type SyncRunSummary } from '@/lib/dashboard/syncHealth';
import { computeSeverity } from '@/lib/dashboard/syncStatus';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const run = (over: Partial<SyncRunSummary>): SyncRunSummary => ({
  id: 'r', status: 'success', startedAt: '2026-09-11T06:00:00Z', finishedAt: '2026-09-11T06:00:02Z',
  stage: null, message: null, sourceRunAt: '2026-09-11T05:59:00Z', rowsCount: 255, triggerSource: 'cron', ...over,
});

describe('computeSyncHealth — the red banner rule', () => {
  it('is ok when the last run succeeded on fresh source data', () => {
    const h = computeSyncHealth({ lastRun: run({}), lastSuccess: run({}), now: NOW, maxAgeHours: 36 });
    expect(h.state).toBe('ok');
  });
  it('is failed when the LAST run failed, and still names the last good source time', () => {
    const failed = run({ id: 'f', status: 'error', stage: 'scrape', message: 'הסריקה בבלינק נכשלה: …', sourceRunAt: null });
    const h = computeSyncHealth({ lastRun: failed, lastSuccess: run({}), now: NOW, maxAgeHours: 36 });
    expect(h.state).toBe('failed');
    if (h.state === 'failed') {
      expect(h.run.stage).toBe('scrape');
      expect(h.sourceRunAt).toBe('2026-09-11T05:59:00Z');
    }
  });
  it('is stale when the last successful run read data older than the threshold', () => {
    const old = run({ sourceRunAt: '2026-08-25T06:21:05Z', finishedAt: '2026-09-10T06:00:00Z' });
    const h = computeSyncHealth({ lastRun: old, lastSuccess: old, now: NOW, maxAgeHours: 36 });
    expect(h.state).toBe('stale');
    if (h.state === 'stale') expect(Math.round(h.ageHours)).toBe(414);
  });
  it('is never when nothing ever succeeded', () => {
    expect(computeSyncHealth({ lastRun: null, lastSuccess: null, now: NOW, maxAgeHours: 36 }).state).toBe('never');
  });
  it('a run in progress does not hide a stale source', () => {
    const running = run({ status: 'running', finishedAt: null, sourceRunAt: null });
    const old = run({ sourceRunAt: '2026-08-25T06:21:05Z' });
    expect(computeSyncHealth({ lastRun: running, lastSuccess: old, now: NOW, maxAgeHours: 36 }).state).toBe('stale');
  });
});

describe('computeSeverity — indicator colour follows the SOURCE time', () => {
  it('ok < 24h, yellow 24h–max, red beyond max or never', () => {
    expect(computeSeverity(new Date(NOW - 1 * 36e5), NOW, 36)).toBe('ok');
    expect(computeSeverity(new Date(NOW - 30 * 36e5), NOW, 36)).toBe('yellow');
    expect(computeSeverity(new Date(NOW - 40 * 36e5), NOW, 36)).toBe('red');
    expect(computeSeverity(null, NOW, 36)).toBe('red');
  });
});
