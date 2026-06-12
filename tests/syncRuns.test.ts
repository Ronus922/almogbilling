import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer so we can assert the SQL/params the sync_runs helpers issue
// (no live database in the test harness).
vi.mock('@/lib/db', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '@/lib/db';
import {
  createSyncRun,
  finishSyncRunSuccess,
  finishSyncRunError,
  getLastSuccessfulSyncAt,
} from '@/lib/db/syncRuns';
import { computeSeverity } from '@/lib/dashboard/syncStatus';

// Loosely-typed mock handles for assertions.
const mQuery = query as unknown as ReturnType<typeof vi.fn>;
const mQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mQuery.mockReset();
  mQueryOne.mockReset();
});

describe('sync_runs — open (createSyncRun)', () => {
  it('inserts a row and returns the id', async () => {
    mQueryOne.mockResolvedValue({ id: 'sync-1' });
    const id = await createSyncRun('user-1');
    expect(id).toBe('sync-1');
    const [sql, params] = mQueryOne.mock.calls[0];
    expect(sql).toMatch(/insert into public\.sync_runs/i);
    expect(params).toEqual(['user-1']);
  });

  it('accepts a null triggered_by (e.g. cron)', async () => {
    mQueryOne.mockResolvedValue({ id: 'x' });
    await createSyncRun(null);
    expect(mQueryOne.mock.calls[0][1]).toEqual([null]);
  });

  it('throws if the insert returns no row', async () => {
    mQueryOne.mockResolvedValue(null);
    await expect(createSyncRun('u')).rejects.toThrow();
  });
});

describe('sync_runs — finish (success / error)', () => {
  it('finishSyncRunSuccess marks success + finished_at', async () => {
    mQuery.mockResolvedValue({ rowCount: 1 });
    await finishSyncRunSuccess('run-1');
    const [sql, params] = mQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'success'/);
    expect(sql).toMatch(/finished_at = now\(\)/);
    expect(params).toEqual(['run-1']);
  });

  it('finishSyncRunError marks error + stores the message', async () => {
    mQuery.mockResolvedValue({ rowCount: 1 });
    await finishSyncRunError('run-2', 'CRM unreachable');
    const [sql, params] = mQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'error'/);
    expect(params[0]).toBe('run-2');
    expect(params[1]).toBe('CRM unreachable');
  });

  it('finishSyncRunError truncates very long messages to 1000 chars', async () => {
    mQuery.mockResolvedValue({ rowCount: 1 });
    await finishSyncRunError('run-3', 'x'.repeat(5000));
    expect((mQuery.mock.calls[0][1][1] as string).length).toBe(1000);
  });
});

describe('sync_runs — combined read (getLastSuccessfulSyncAt)', () => {
  it('returns the latest successful finished_at', async () => {
    const d = new Date('2026-06-12T10:00:00Z');
    mQueryOne.mockResolvedValue({ last_at: d });
    const r = await getLastSuccessfulSyncAt();
    expect(r).toBe(d);
    expect(mQueryOne.mock.calls[0][0]).toMatch(/status = 'success'/);
    expect(mQueryOne.mock.calls[0][0]).toMatch(/max\(finished_at\)/);
  });

  it('returns null when there is no successful sync', async () => {
    mQueryOne.mockResolvedValue({ last_at: null });
    expect(await getLastSuccessfulSyncAt()).toBeNull();
  });

  it('returns null when the query yields no row', async () => {
    mQueryOne.mockResolvedValue(null);
    expect(await getLastSuccessfulSyncAt()).toBeNull();
  });
});

describe('computeSeverity — driven by last import only', () => {
  const now = new Date('2026-06-12T12:00:00Z').getTime();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000);

  it('never imported → red', () => {
    expect(computeSeverity(null, now)).toBe('red');
  });
  it('< 24h → ok', () => {
    expect(computeSeverity(hoursAgo(2), now)).toBe('ok');
  });
  it('exactly 24h → ok (boundary)', () => {
    expect(computeSeverity(hoursAgo(24), now)).toBe('ok');
  });
  it('24–48h → yellow', () => {
    expect(computeSeverity(hoursAgo(30), now)).toBe('yellow');
  });
  it('> 48h → red', () => {
    expect(computeSeverity(hoursAgo(60), now)).toBe('red');
  });
});
