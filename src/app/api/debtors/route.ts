import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listDebtors, ALL_SORT_KEYS, type TabKey, type SortKey } from '@/lib/db/debtors';

export const runtime = 'nodejs';

const VALID_TABS: TabKey[] = ['active', 'warning', 'legal-care', 'legal-proceeding', 'actions', 'archived'];

export async function GET(req: NextRequest) {
  try {
    await requirePermission('contacts', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const tabParam = sp.get('tab') ?? 'active';
  const tab = (VALID_TABS as string[]).includes(tabParam) ? (tabParam as TabKey) : 'active';
  const q = sp.get('q')?.trim() || undefined;
  const apt = sp.get('apt')?.trim() || undefined;
  const sortParam = sp.get('sort') ?? '';
  const sort: SortKey = (ALL_SORT_KEYS as readonly string[]).includes(sortParam)
    ? (sortParam as SortKey)
    : 'total_debt_desc';
  const page = Number(sp.get('page') ?? '1') || 1;

  const result = await listDebtors({ tab, q, apt, sort, page });
  return NextResponse.json(result);
}
