import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer so we can assert the SQL/params the sync_runs helpers issue
// (no live database in the test harness).
vi.mock('@/lib/db', () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { query, queryOne } from '@/lib/db';
import {
  createSyncRun,
  finishSyncRunSuccess,
  finishSyncRunError,
  getLastSuccessfulSyncRun,
  getLastSyncRun,
  listRecentSyncRuns,
} from '@/lib/db/syncRuns';

// Loosely-typed mock handles for assertions.
const mQuery = query as unknown as ReturnType<typeof vi.fn>;
const mQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mQuery.mockReset();
  mQueryOne.mockReset();
});

describe('sync_runs — open (createSyncRun)', () => {
  it('inserts a row with the actor + trigger source and returns the id', async () => {
    mQueryOne.mockResolvedValue({ id: 'sync-1' });
    const id = await createSyncRun({ triggeredBy: 'user-1', source: 'ui' });
    expect(id).toBe('sync-1');
    const [sql, params] = mQueryOne.mock.calls[0];
    expect(sql).toMatch(/insert into public\.sync_runs/i);
    expect(sql).toMatch(/trigger_source/);
    expect(params).toEqual(['user-1', 'ui']);
  });

  it('a cron run has no actor', async () => {
    mQueryOne.mockResolvedValue({ id: 'x' });
    await createSyncRun({ triggeredBy: null, source: 'cron' });
    expect(mQueryOne.mock.calls[0][1]).toEqual([null, 'cron']);
  });

  it('throws if the insert returns no row', async () => {
    mQueryOne.mockResolvedValue(null);
    await expect(createSyncRun({ triggeredBy: 'u', source: 'ui' })).rejects.toThrow();
  });
});

describe('sync_runs — finish (success / error)', () => {
  it('finishSyncRunSuccess stores source_run_at, rows_count and the import run', async () => {
    mQuery.mockResolvedValue({ rowCount: 1 });
    await finishSyncRunSuccess('run-1', { sourceRunAt: '2026-09-11T06:35:41Z', rowsCount: 255, importRunId: 'imp-1' });
    const [sql, params] = mQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'success'/);
    expect(sql).toMatch(/finished_at = now\(\)/);
    expect(sql).toMatch(/source_run_at = \$2/);
    expect(params).toEqual(['run-1', '2026-09-11T06:35:41Z', 255, 'imp-1']);
  });

  it('finishSyncRunError stores the stage, the full message and the source time', async () => {
    mQuery.mockResolvedValue({ rowCount: 1 });
    await finishSyncRunError('run-2', { stage: 'scrape', message: 'הסריקה בבלינק נכשלה: …', sourceRunAt: null });
    const [sql, params] = mQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'error'/);
    expect(sql).toMatch(/error_stage = \$2/);
    expect(params).toEqual(['run-2', 'scrape', 'הסריקה בבלינק נכשלה: …', null, null]);
  });

  it('finishSyncRunError keeps long CRM error texts (up to 4000 chars)', async () => {
    mQuery.mockResolvedValue({ rowCount: 1 });
    await finishSyncRunError('run-3', { stage: 'pull', message: 'x'.repeat(5000), sourceRunAt: null });
    expect((mQuery.mock.calls[0][1][2] as string).length).toBe(4000);
  });
});

describe('sync_runs — reads', () => {
  it('getLastSuccessfulSyncRun filters on success, newest first', async () => {
    mQueryOne.mockResolvedValue({ id: 'ok-1', status: 'success' });
    const r = await getLastSuccessfulSyncRun();
    expect(r?.id).toBe('ok-1');
    expect(mQueryOne.mock.calls[0][0]).toMatch(/status = 'success'/);
    expect(mQueryOne.mock.calls[0][0]).toMatch(/order by started_at desc/);
  });

  it('getLastSyncRun takes the newest run of any status', async () => {
    mQueryOne.mockResolvedValue({ id: 'any-1', status: 'error' });
    const r = await getLastSyncRun();
    expect(r?.status).toBe('error');
    expect(mQueryOne.mock.calls[0][0]).not.toMatch(/status =/);
  });

  it('listRecentSyncRuns joins the triggering user and honours the limit', async () => {
    mQuery.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
    const rows = await listRecentSyncRuns(30);
    expect(rows).toHaveLength(2);
    const [sql, params] = mQuery.mock.calls[0];
    expect(sql).toMatch(/left join public\.users/);
    expect(params).toEqual([30]);
  });

  it('reads return null when the query yields no row', async () => {
    mQueryOne.mockResolvedValue(null);
    expect(await getLastSuccessfulSyncRun()).toBeNull();
  });
});
