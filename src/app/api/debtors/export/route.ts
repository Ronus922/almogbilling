import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listAllDebtorsForExport,
  ALL_SORT_KEYS,
  type TabKey,
  type SortKey,
} from '@/lib/db/debtors';

export const runtime = 'nodejs';

const VALID_TABS: TabKey[] = ['active', 'warning', 'legal-care', 'legal-proceeding', 'actions', 'archived'];

// GET /api/debtors/export?tab&q&apt&sort  (export:view)
// Returns ALL debtor rows matching the current filter (tab + search + sort) —
// no pagination. Used by the toolbar's Excel / PDF / Print, whose scope is the
// full filtered set, not just the visible page. Bulk download is a privileged
// capability (`export`), held by manager+ but NOT by a read-only viewer — so a
// viewer can read the on-screen debtors table but cannot bulk-export it.
export async function GET(req: NextRequest) {
  try {
    await requirePermission('export', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const tab = (VALID_TABS as string[]).includes(sp.get('tab') ?? '')
    ? (sp.get('tab') as TabKey)
    : 'active';
  const q = sp.get('q')?.trim() || undefined;
  const apt = sp.get('apt')?.trim() || undefined;
  const sort: SortKey = (ALL_SORT_KEYS as readonly string[]).includes(sp.get('sort') ?? '')
    ? (sp.get('sort') as SortKey)
    : 'total_debt_desc';

  const rows = await listAllDebtorsForExport({ tab, q, apt, sort });
  return NextResponse.json({ rows });
}
