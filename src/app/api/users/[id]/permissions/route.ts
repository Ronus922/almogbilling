import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { query } from '@/lib/db';
import { findUserById } from '@/lib/db/users';
import { MODULES, type ModulePermission } from '@/lib/permissions/constants';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PutBody {
  module?: unknown;
  can_view?: unknown;
  can_edit?: unknown;
}

interface PermissionRow {
  module: string;
  can_view: boolean;
  can_edit: boolean;
}

const VALID_MODULES = new Set(MODULES.map((m) => m.key));

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const target = await findUserById(id);
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const r = await query<PermissionRow>(
    `select module, can_view, can_edit
       from public.user_permissions
       where user_id = $1`,
    [id],
  );
  const permissions: ModulePermission[] = r.rows.map((row) => ({
    module: row.module,
    canView: row.can_view,
    canEdit: row.can_edit,
  }));
  return NextResponse.json({ permissions });
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  try {
    await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const target = await findUserById(id);
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (target.role !== 'manager' && target.role !== 'viewer') {
    return NextResponse.json(
      { error: 'מטריצת הרשאות חלה רק על מנהל פעילות וצופה' },
      { status: 400 },
    );
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const module = typeof body.module === 'string' ? body.module : '';
  if (!VALID_MODULES.has(module)) {
    return NextResponse.json({ error: 'מודול לא תקין' }, { status: 400 });
  }
  const canView = body.can_view === true;
  const canEdit = body.can_edit === true;
  if (canEdit && !canView) {
    return NextResponse.json(
      { error: 'לא ניתן לאפשר עריכה ללא הרשאת צפייה' },
      { status: 400 },
    );
  }

  await query(
    `insert into public.user_permissions (user_id, module, can_view, can_edit)
     values ($1, $2, $3, $4)
     on conflict (user_id, module) do update
       set can_view = excluded.can_view,
           can_edit = excluded.can_edit,
           updated_at = now()`,
    [target.id, module, canView, canEdit],
  );

  return NextResponse.json({ ok: true });
}
