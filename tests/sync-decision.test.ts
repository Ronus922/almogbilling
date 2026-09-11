import { describe, expect, it } from 'vitest';
import {
  SyncStageError,
  checkSnapshotFreshness,
  parseCrmScrapeResponse,
  stageHttpStatus,
} from '@/lib/sync/decision';
import { secretsMatch } from '@/lib/auth/cronSecret';

// The exact bodies the CRM produced during the 25/08–11/09/2026 outage.
const LOGIN_TIMEOUT_BODY = {
  ok: true,
  result: {
    downloaded: false, parsed: 0, debtorUpserted: 0, contactsUpserted: 0,
    errors: ["Download failed: TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'התחברות לחשבון' })\n"],
  },
};
const MISSING_BROWSER_BODY = {
  ok: true,
  result: { downloaded: false, parsed: 0, debtorUpserted: 0, contactsUpserted: 0, errors: ["Download failed: Error: browserType.launch: Executable doesn't exist at /home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1208/…"] },
};
const SUCCESS_BODY = { ok: true, result: { downloaded: true, parsed: 255, debtorUpserted: 255, contactsUpserted: 255, errors: [] } };

describe('parseCrmScrapeResponse — (a) a CRM failure body is a scrape failure, even with HTTP 200', () => {
  it('rejects downloaded=false and carries the CRM error text in full', () => {
    const r = parseCrmScrapeResponse(200, LOGIN_TIMEOUT_BODY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('הסריקה בבלינק נכשלה');
      expect(r.message).toContain("getByRole('button', { name: 'התחברות לחשבון' })");
    }
  });
  it('rejects the missing-browser body', () => {
    const r = parseCrmScrapeResponse(200, MISSING_BROWSER_BODY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Executable doesn't exist");
  });
  it('rejects downloaded=true when errors[] is not empty', () => {
    const r = parseCrmScrapeResponse(200, { ok: true, result: { downloaded: true, parsed: 3, errors: ['contacts upsert failed: x'] } });
    expect(r.ok).toBe(false);
  });
  it('rejects non-2xx, unauthorized and malformed answers', () => {
    expect(parseCrmScrapeResponse(401, { ok: false, error: 'unauthorized' }).ok).toBe(false);
    expect(parseCrmScrapeResponse(502, null).ok).toBe(false);
    expect(parseCrmScrapeResponse(200, null).ok).toBe(false);
    expect(parseCrmScrapeResponse(200, { ok: true }).ok).toBe(false);
    expect(parseCrmScrapeResponse(200, { ok: false, error: 'unknown_job' }).ok).toBe(false);
  });
  it('accepts the genuine success body', () => {
    expect(parseCrmScrapeResponse(200, SUCCESS_BODY)).toEqual({ ok: true, parsed: 255 });
  });
});

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
