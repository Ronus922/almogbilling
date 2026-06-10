import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { query, withTransaction } from '@/lib/db';
import {
  findUserById,
  countActiveSuperAdminsExcluding,
} from '@/lib/db/users';
import { getDefaultPermissions } from '@/lib/permissions/check';
import type { ModulePermission, Role } from '@/lib/permissions/constants';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  full_name?: unknown;
  role?: unknown;
  is_active?: unknown;
}

interface PermissionRow {
  module: string;
  can_view: boolean;
  can_edit: boolean;
}

const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'manager', 'viewer', 'super_admin'];

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const user = await findUserById(id);
  if (!user) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let permissions: ModulePermission[] = [];
  if (user.role === 'manager' || user.role === 'viewer') {
    const r = await query<PermissionRow>(
      `select module, can_view, can_edit
         from public.user_permissions
         where user_id = $1`,
      [id],
    );
    permissions = r.rows.map((row) => ({
      module: row.module,
      canView: row.can_view,
      canEdit: row.can_edit,
    }));
  }

  return NextResponse.json({ user, permissions });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const target = await findUserById(id);
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const wantsFullName = 'full_name' in body;
  const wantsRole = 'role' in body;
  const wantsActive = 'is_active' in body;

  let nextFullName: string | null = target.full_name;
  if (wantsFullName) {
    const v = typeof body.full_name === 'string' ? body.full_name.trim() : '';
    if (v.length < 2 || v.length > 80) {
      return NextResponse.json({ error: 'שם מלא חייב להיות 2-80 תווים' }, { status: 400 });
    }
    nextFullName = v;
  }

  let nextRole: Role = target.role;
  if (wantsRole) {
    const v = body.role;
    if (typeof v !== 'string' || !(ASSIGNABLE_ROLES as readonly string[]).includes(v)) {
      return NextResponse.json({ error: 'תפקיד לא תקין' }, { status: 400 });
    }
    nextRole = v as Role;
  }

  let nextActive: boolean = target.is_active;
  if (wantsActive) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active חייב להיות boolean' }, { status: 400 });
    }
    nextActive = body.is_active;
  }

  // ── Self-protection ─────────────────────────────────────────────
  if (target.id === actor.id && wantsRole && nextRole !== target.role) {
    return NextResponse.json({ error: 'אסור לשנות תפקיד של עצמך' }, { status: 403 });
  }
  if (target.id === actor.id && wantsActive && nextActive === false) {
    return NextResponse.json({ error: 'אסור להשבית את עצמך' }, { status: 403 });
  }

  // ── Cannot demote/disable another super_admin ───────────────────
  if (target.role === 'super_admin' && target.id !== actor.id) {
    if (wantsRole && nextRole !== 'super_admin') {
      return NextResponse.json(
        { error: 'אסור לשנות תפקיד של סופר אדמין אחר' },
        { status: 403 },
      );
    }
    if (wantsActive && nextActive === false) {
      return NextResponse.json(
        { error: 'אסור להשבית סופר אדמין אחר' },
        { status: 403 },
      );
    }
  }

  // ── Last-admin guard ───────────────────────────────────────────
  // If demoting/disabling a super_admin (including self via active flag check
  // that was rejected above), ensure at least one other active super_admin remains.
  const willDemote = target.role === 'super_admin' && wantsRole && nextRole !== 'super_admin';
  const willDisable = target.role === 'super_admin' && target.is_active && wantsActive && nextActive === false;
  if (willDemote || willDisable) {
    const remaining = await countActiveSuperAdminsExcluding(target.id);
    if (remaining === 0) {
      return NextResponse.json(
        { error: 'לא ניתן להשאיר את המערכת ללא סופר אדמין פעיל' },
        { status: 409 },
      );
    }
  }

  const roleChanged = nextRole !== target.role;
  const activeChanged = nextActive !== target.is_active;

  await withTransaction(async (client) => {
    await client.query(
      `update public.users
         set full_name = $1, role = $2, is_active = $3
         where id = $4`,
      [nextFullName, nextRole, nextActive, target.id],
    );

    if (roleChanged) {
      const prevHadMatrix = target.role === 'manager' || target.role === 'viewer';
      const nextHasMatrix = nextRole === 'manager' || nextRole === 'viewer';

      if (prevHadMatrix && !nextHasMatrix) {
        await client.query(
          `delete from public.user_permissions where user_id = $1`,
          [target.id],
        );
      } else if (nextHasMatrix) {
        // Wipe & seed defaults for the new role.
        await client.query(
          `delete from public.user_permissions where user_id = $1`,
          [target.id],
        );
        const defaults = getDefaultPermissions(nextRole) ?? [];
        for (const p of defaults) {
          await client.query(
            `insert into public.user_permissions (user_id, module, can_view, can_edit)
             values ($1, $2, $3, $4)`,
            [target.id, p.module, p.canView, p.canEdit],
          );
        }
      }
    }

    // Force re-login on role/active change so the actor refreshes from DB.
    if (roleChanged || activeChanged) {
      await client.query(
        `delete from public.sessions where user_id = $1`,
        [target.id],
      );
    }
  });

  const updated = await findUserById(target.id);
  return NextResponse.json({ user: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const target = await findUserById(id);
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (target.id === actor.id) {
    return NextResponse.json({ error: 'אסור להשבית את עצמך' }, { status: 403 });
  }

  if (target.role === 'super_admin') {
    const remaining = await countActiveSuperAdminsExcluding(target.id);
    if (remaining === 0) {
      return NextResponse.json(
        { error: 'לא ניתן להשבית את הסופר אדמין האחרון' },
        { status: 409 },
      );
    }
  }

  await withTransaction(async (client) => {
    await client.query(
      `update public.users set is_active = false where id = $1`,
      [target.id],
    );
    await client.query(
      `delete from public.sessions where user_id = $1`,
      [target.id],
    );
  });

  return NextResponse.json({ ok: true });
}
