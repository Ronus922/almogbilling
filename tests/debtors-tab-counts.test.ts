import { beforeEach, describe, expect, it, vi } from 'vitest';

// The debtors screen's tab badges and its table (06/10/2026): one search, one
// predicate. The badge of "מכתבי התראה" showed 9 over a table of 0 because the
// counts ignored the toolbar's ?q= / ?apt= while the rows honoured them — and
// the search sticks across tab clicks. Locked here: getTabCounts takes the
// same search as listDebtors and listAllDebtorsForExport, the three emit the
// SAME predicate text with the SAME params, and with no search the counts are
// the plain stage totals (no where-clause at all).

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    if (/as warning,/.test(sql)) {
      return { active: '83', warning: '9', legal_care: '0', legal_proceeding: '10', actions: '2', archived: '5' };
    }
    return { c: '0' };
  }),
  withTransaction: vi.fn(),
}));

import { getTabCounts, listAllDebtorsForExport, listDebtors } from '@/lib/db/debtors';

beforeEach(() => {
  h.calls = [];
});

const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
/** Whatever follows the registry join — the query's own where-clause (the
 *  count filters and the doc_count sub-selects have their own `where`s). */
const afterJoin = (sql: string) => normalise(sql).split('rc.id = d.contact_id')[1]?.trim() ?? '';
/** The predicate(s) of the query's where-clause. */
function searchClause(sql: string): string {
  const m = afterJoin(sql).match(/^where (.*?)(?: order by| limit|$)/);
  return m?.[1] ?? '';
}

describe('getTabCounts — the badges follow the search', () => {
  it('no search: the stage totals of the whole building, no where-clause', async () => {
    const counts = await getTabCounts();
    expect(counts).toEqual({ active: 83, warningLetter: 9, legalCare: 0, legalProceeding: 10, actions: 2, archived: 5 });
    const [call] = h.calls;
    expect(call).toBeDefined();
    expect(afterJoin(call!.sql)).toBe('');
    expect(call!.params).toEqual(['מכתב התראה', 'לטיפול משפטי', 'בהליך משפטי']);
  });

  it('with a search: the same owner-name and apartment predicates as the table, through the registry join', async () => {
    await getTabCounts({ q: 'יעל', apt: '12' });
    const [call] = h.calls;
    const sql = normalise(call!.sql);
    expect(sql).toMatch(/left join public\.contacts rc on rc\.id = d\.contact_id/);
    expect(afterJoin(sql)).toBe('where case when rc.id is null then d.owner_name else rc.owner_name end ilike $4 and d.apartment_number ilike $5');
    expect(call!.params).toEqual(['מכתב התראה', 'לטיפול משפטי', 'בהליך משפטי', '%יעל%', '%12%']);
  });

  it('an empty string is no search', async () => {
    await getTabCounts({ q: '', apt: '' });
    expect(afterJoin(h.calls[0]!.sql)).toBe('');
  });
});

describe('the badges, the rows and the export agree on what the search means', () => {
  it('one predicate text, one param shape, in all three', async () => {
    await getTabCounts({ q: 'יעל', apt: '12' });
    await listDebtors({ tab: 'warning', q: 'יעל', apt: '12' });
    await listAllDebtorsForExport({ tab: 'warning', q: 'יעל', apt: '12' });

    const counts = h.calls[0]!;
    const rows = h.calls[1]!;
    const total = h.calls[2]!;
    const exported = h.calls[3]!;

    // The counts carry the three stage names first, the search last; the
    // tab-scoped queries carry the one stage name first, the search last.
    const countsSearch = searchClause(counts.sql);
    const rowsSearch = searchClause(rows.sql).replace(/^d\.is_archived = false and s\.name = \$1 and /, '');
    const totalSearch = searchClause(total.sql).replace(/^d\.is_archived = false and s\.name = \$1 and /, '');
    const exportSearch = searchClause(exported.sql).replace(/^d\.is_archived = false and s\.name = \$1 and /, '');
    const renumber = (s: string) => s.replace(/\$\d+/g, '$N');
    expect(renumber(rowsSearch)).toBe(renumber(countsSearch));
    expect(renumber(totalSearch)).toBe(renumber(countsSearch));
    expect(renumber(exportSearch)).toBe(renumber(countsSearch));

    expect(counts.params.slice(-2)).toEqual(['%יעל%', '%12%']);
    expect(rows.params).toEqual(['מכתב התראה', '%יעל%', '%12%', 50, 0]);
    expect(total.params).toEqual(['מכתב התראה', '%יעל%', '%12%']);
    expect(exported.params).toEqual(['מכתב התראה', '%יעל%', '%12%']);
  });

  it('every tab keeps its own stage predicate under a search', async () => {
    const tabs = ['active', 'warning', 'legal-care', 'legal-proceeding', 'actions', 'archived'] as const;
    for (const tab of tabs) {
      h.calls = [];
      await listDebtors({ tab, q: 'x' });
      const clause = searchClause(h.calls[0]!.sql);
      expect(clause, tab).toMatch(/ilike \$\d+$/);
      if (tab === 'archived') expect(clause).toMatch(/^d\.is_archived = true and/);
      else expect(clause).toMatch(/^d\.is_archived = false and/);
    }
  });
});
