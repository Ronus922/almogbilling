import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// "סנכרן עכשיו" scrapes Bllink for real (27/09/2026). Before this, a manual sync
// re-copied the 05:30 snapshot: five presses on 27/09 all wrote the same
// source_run_at and the numbers on screen never moved.
//
// Exercised through the REAL route and the real decision layer; only the world
// outside it is mocked (auth, rate limit, the two DB layers, the systemd unit).
// What is pinned here:
//   • fresh + UI            → the unit runs BEFORE the copy, and the copy happens
//   • unit failed           → stage 'scrape', nothing copied
//   • unit ok, no NEW scrape (the advisory-lock skip) → stage 'scrape', nothing copied
//   • cron, even with fresh → never scrapes (the timer already did, 05:30)
//   • no body at all        → exactly the old behaviour (what the timer posts)
//   • BLLINK_SOURCE=crm     → the flag is ignored, the CRM path is untouched
const h = vi.hoisted(() => ({
  source: 'billing' as string,
  snapshotFinishedAt: '' as string,
  unit: { ok: true } as { ok: true } | { ok: false; reason: string },
}));

vi.mock('@/env', () => ({
  env: {
    get BLLINK_SOURCE() {
      return h.source;
    },
    BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS: '20',
    BLLINK_MAX_SNAPSHOT_AGE_HOURS: '36',
    CRM_CRON_SECRET: 'cron-secret',
    CRM_SYNC_URL: 'http://crm.test/api/admin/jobs/syncBllinkDebt',
  },
}));
vi.mock('@/lib/auth/actor', () => ({ requirePermission: vi.fn(async () => ({ id: 'actor-1' })) }));
vi.mock('@/lib/auth/apiGuard', () => ({ authErrorResponse: vi.fn(() => null) }));
vi.mock('@/lib/auth/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
  clientIp: vi.fn(() => '10.0.0.1'),
}));
vi.mock('@/lib/db/syncRuns', () => ({
  createSyncRun: vi.fn(async () => 'sync-run-1'),
  finishSyncRunSuccess: vi.fn(async () => undefined),
  finishSyncRunError: vi.fn(async () => undefined),
}));
vi.mock('@/lib/db/importRuns', () => ({ createImportRun: vi.fn(async () => 'import-run-1') }));
vi.mock('@/lib/sync/localPull', () => ({
  fetchLocalDebtorRows: vi.fn(async () => ({
    scrapeId: 'scrape-1',
    finishedAt: h.snapshotFinishedAt,
    rows: [],
    report: { count: 0, rawTotal: 0, componentTotal: 0, runMinAt: h.snapshotFinishedAt, runMaxAt: h.snapshotFinishedAt },
    compareRows: new Map(),
  })),
  recordWitnessCompare: vi.fn(async () => undefined),
}));
vi.mock('@/lib/sync/bllinkPull', () => ({
  fetchCrmDebtorRows: vi.fn(async () => ({
    rows: [],
    report: {
      count: 0,
      rawTotal: 0,
      componentTotal: 0,
      runMinAt: h.snapshotFinishedAt,
      runMaxAt: h.snapshotFinishedAt,
    },
  })),
  writeCrmSnapshot: vi.fn(async () => 0),
}));
vi.mock('@/lib/sync/scrapeUnit', () => ({ runScrapeUnit: vi.fn(async () => h.unit) }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { POST } from '@/app/api/sync/bllink/route';
import { runScrapeUnit } from '@/lib/sync/scrapeUnit';
import { writeCrmSnapshot } from '@/lib/sync/bllinkPull';
import { finishSyncRunError } from '@/lib/db/syncRuns';

const mUnit = runScrapeUnit as unknown as ReturnType<typeof vi.fn>;
const mWrite = writeCrmSnapshot as unknown as ReturnType<typeof vi.fn>;
const mFail = finishSyncRunError as unknown as ReturnType<typeof vi.fn>;

/** A snapshot dated `secondsAgo` before now — inside the 20h freshness limit. */
function snapshotAgedSeconds(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function post(body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/sync/bllink', {
    method: 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.source = 'billing';
  h.unit = { ok: true };
  // The scrape the unit "just made": dated after the request starts.
  h.snapshotFinishedAt = snapshotAgedSeconds(-1);
});

describe('POST /api/sync/bllink — fresh scrape', () => {
  it('runs the scrape unit and then copies the new snapshot', async () => {
    const res = await POST(post({ fresh: true }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mUnit).toHaveBeenCalledTimes(1);
    expect(mWrite).toHaveBeenCalledTimes(1);
  });

  it('fails on stage scrape and copies nothing when the unit fails', async () => {
    h.unit = { ok: false, reason: 'Job for billing-bllink-scrape.service failed' };
    const res = await POST(post({ fresh: true }));
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.stage).toBe('scrape');
    expect(body.message).toContain('סריקת בלינק נכשלה');
    expect(mWrite).not.toHaveBeenCalled();
    expect(mFail.mock.calls[0][1]).toMatchObject({ stage: 'scrape' });
  });

  it('refuses to answer "סונכרנו" when no NEW scrape appeared (the lock-skip case)', async () => {
    // The unit exits 0 when another scrape holds the advisory lock, so the only
    // proof of freshness is the timestamp: this snapshot is from this morning.
    h.snapshotFinishedAt = snapshotAgedSeconds(6 * 3600);
    const res = await POST(post({ fresh: true }));
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.stage).toBe('scrape');
    expect(body.message).toContain('סריקה אחרת של בלינק רצה כרגע');
    expect(mWrite).not.toHaveBeenCalled();
  });

  it('never scrapes for a cron caller, even when the body asks for it', async () => {
    const res = await POST(post({ fresh: true }, { 'x-cron-secret': 'cron-secret' }));
    expect(res.status).toBe(200);
    expect(mUnit).not.toHaveBeenCalled();
    expect(mWrite).toHaveBeenCalledTimes(1);
  });

  it('treats a missing body as {} — what billing-sync.timer posts', async () => {
    const res = await POST(post(undefined, { 'x-cron-secret': 'cron-secret' }));
    expect(res.status).toBe(200);
    expect(mUnit).not.toHaveBeenCalled();
    expect(mWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed body without starting a run', async () => {
    const req = new NextRequest('http://localhost/api/sync/bllink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('invalid_json');
    expect(mUnit).not.toHaveBeenCalled();
  });

  it('ignores the flag when BLLINK_SOURCE=crm — that path scrapes the CRM already', async () => {
    h.source = 'crm';
    // The CRM path asks the CRM to scrape over HTTP; that request is the one
    // stubbed here, so the assertion is about WHICH scraper ran, not about fetch.
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: { downloaded: true, parsed: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await POST(post({ fresh: true }));
      expect(res.status).toBe(200);
      expect(mUnit).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mWrite).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
