import { describe, expect, it } from 'vitest';
import { computeSyncHealth, effectiveSourceRunAt, redactSyncRunForViewer, type SyncRunSummary } from '@/lib/dashboard/syncHealth';
import { computeSeverity } from '@/lib/dashboard/syncStatus';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SyncHealthBanner } from '@/app/(app)/dashboard/components/SyncHealthBanner';
import { SYNC_FAILURE_ADVICE, SYNC_FAILURE_TITLE } from '@/lib/dashboard/syncCopy';

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
  it('a legacy success (no source_run_at) still counts, anchored to its finish time — also under a failed last run', () => {
    // The 11/09/2026 09:34 run was recorded by the old code: success, source_run_at null.
    const legacy = run({ id: 'legacy', sourceRunAt: null, finishedAt: '2026-09-11T09:34:07Z' });
    expect(effectiveSourceRunAt(legacy)).toBe('2026-09-11T09:34:07Z');
    expect(effectiveSourceRunAt(run({ status: 'error', sourceRunAt: null }))).toBeNull();
    expect(effectiveSourceRunAt(null)).toBeNull();
    const ok = computeSyncHealth({ lastRun: legacy, lastSuccess: legacy, now: NOW, maxAgeHours: 36 });
    expect(ok).toMatchObject({ state: 'ok', sourceRunAt: '2026-09-11T09:34:07Z' });
    const failed = run({ id: 'f', status: 'error', stage: 'scrape', sourceRunAt: null });
    const h = computeSyncHealth({ lastRun: failed, lastSuccess: legacy, now: NOW, maxAgeHours: 36 });
    expect(h).toMatchObject({ state: 'failed', sourceRunAt: '2026-09-11T09:34:07Z' });
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

describe('SyncHealthBanner — the wording every user sees (11/09/2026)', () => {
  const CRM_MESSAGE = "הסריקה בבלינק נכשלה: Download failed: TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'התחברות לחשבון' })";
  const failedRun = run({ id: 'f', status: 'error', stage: 'scrape', message: CRM_MESSAGE, sourceRunAt: null, triggerSource: 'cron', finishedAt: '2026-09-11T16:06:14Z' });
  const failed = computeSyncHealth({ lastRun: failedRun, lastSuccess: run({ sourceRunAt: '2026-09-11T13:50:49Z' }), now: NOW, maxAgeHours: 36 });
  const html = (health: ReturnType<typeof computeSyncHealth>, isAdmin: boolean) =>
    renderToStaticMarkup(createElement(SyncHealthBanner, { health, isAdmin }));
  // Anything an ordinary user must never read in the banner.
  const TECHNICAL = ['פרטים טכניים', 'שלב:', 'סריקת בלינק', 'סנכרון אוטומטי', 'הפעלה ידנית', 'נכשל ב-', 'Download failed', 'TimeoutError', 'getByRole', '<details', 'הודעה:'];

  it('renders nothing when the sync is healthy', () => {
    const ok = computeSyncHealth({ lastRun: run({}), lastSuccess: run({}), now: NOW, maxAgeHours: 36 });
    expect(html(ok, true)).toBe('');
  });
  it('shows exactly the three lines — title, last update (source time), what to do', () => {
    const out = html(failed, false);
    expect(out).toContain(SYNC_FAILURE_TITLE);
    expect(out).toContain('עדכון אחרון:');
    expect(out).toContain('11.09.2026 16:50'); // 13:50Z in Asia/Jerusalem
    expect(out).toContain(SYNC_FAILURE_ADVICE);
    expect(out).toContain('רונן משולם');
    expect(out).toContain('role="alert"');
  });
  it('a non-admin gets no technical text in the HTML at all', () => {
    const out = html(failed, false);
    for (const t of TECHNICAL) expect(out, t).not.toContain(t);
  });
  it('an admin gets a closed-by-default "פרטים טכניים" disclosure with when/source/stage/message', () => {
    const out = html(failed, true);
    expect(out).toContain('<details');
    expect(out).not.toContain('<details open');
    expect(out).toContain('פרטים טכניים');
    expect(out).toContain('סנכרון אוטומטי');
    expect(out).toContain('שלב: סריקת בלינק ב-CRM');
    expect(out).toContain('Download failed');
    expect(out).toContain('dir="auto"');
  });
  it('a stale snapshot reads exactly like a failure — the user cannot tell them apart', () => {
    const old = run({ sourceRunAt: '2026-08-25T06:21:05Z', finishedAt: '2026-09-10T06:00:00Z' });
    const stale = computeSyncHealth({ lastRun: old, lastSuccess: old, now: NOW, maxAgeHours: 36 });
    expect(stale.state).toBe('stale');
    const out = html(stale, false);
    expect(out).toContain(SYNC_FAILURE_TITLE);
    expect(out).toContain('25.08.2026 09:21');
    expect(out).toContain(SYNC_FAILURE_ADVICE);
    expect(out).not.toContain('שעות');
    expect(out).not.toContain('ישן');
    // the age lives only in the admin disclosure
    expect(html(stale, true)).toContain('מעל הסף של 36 שעות');
  });
  it('with no successful sync ever: "עדכון אחרון: אין"', () => {
    const never = computeSyncHealth({ lastRun: null, lastSuccess: null, now: NOW, maxAgeHours: 36 });
    const out = html(never, false);
    expect(out).toContain(SYNC_FAILURE_TITLE);
    expect(out).toContain('עדכון אחרון: <span>אין</span>');
    // a failed last run with no success ever → also "אין"
    const failedNever = computeSyncHealth({ lastRun: failedRun, lastSuccess: null, now: NOW, maxAgeHours: 36 });
    expect(html(failedNever, false)).toContain('עדכון אחרון: <span>אין</span>');
  });
});

describe('redactSyncRunForViewer — what a non-admin browser may receive', () => {
  it('keeps outcome and times, drops the stage and the CRM message', () => {
    const failed = run({ id: 'f', status: 'error', stage: 'scrape', message: 'Download failed: TimeoutError …', sourceRunAt: null });
    const r = redactSyncRunForViewer(failed);
    expect(r).toMatchObject({ id: 'f', status: 'error', stage: null, message: null, startedAt: failed.startedAt, finishedAt: failed.finishedAt, triggerSource: 'cron' });
    expect(JSON.stringify(r)).not.toContain('Download failed');
    expect(JSON.stringify(r)).not.toContain('scrape');
    expect(redactSyncRunForViewer(null)).toBeNull();
  });
});
