import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAnyPermission } from '@/lib/auth/actor';
import type { Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listStatusesWithCounts,
  findStatusByLowerName,
  createStatus,
} from '@/lib/db/statuses';
import { validateStatusForm } from '@/lib/validation/status';

export const runtime = 'nodejs';

// GET /api/statuses
//   default               → active rows only (legacy contract — used by panel)
//   ?include=all          → all rows (admin /statuses screen)
// Response always includes `linked_count` and the new admin fields
// (`is_system`, `notification_emails`). Older consumers ignore the extras.
export async function GET(req: NextRequest) {
  const includeAll = req.nextUrl.searchParams.get('include') === 'all';
  try {
    if (includeAll) {
      // Admin /statuses screen — full rows incl. archived + admin fields.
      await requirePermission('status_management', 'view');
    } else {
      // Default (active rows) feeds the debtor detail panel's status display, so
      // a debtors-screen viewer (`dashboard`) may read it too — without granting
      // access to the standalone status-management screen.
      await requireAnyPermission([
        { module: 'dashboard', action: 'view' },
        { module: 'status_management', action: 'view' },
      ]);
    }
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const rows = await listStatusesWithCounts(includeAll);
  return NextResponse.json(rows);
}

// POST /api/statuses (status_management:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('status_management', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = validateStatusForm(body as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: 'validation', errors: result.errors }, { status: 400 });
  }

  const clash = await findStatusByLowerName(result.value.name, null);
  if (clash) {
    return NextResponse.json(
      { error: 'name_taken', message: 'סטטוס בשם זה כבר קיים', field: 'name' },
      { status: 409 },
    );
  }

  try {
    const created = await createStatus(result.value, { userId: actor.id });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e.code === '23505' && e.constraint === 'statuses_name_key') {
      return NextResponse.json(
        { error: 'name_taken', message: 'סטטוס בשם זה כבר קיים', field: 'name' },
        { status: 409 },
      );
    }
    console.error('[POST /api/statuses]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
