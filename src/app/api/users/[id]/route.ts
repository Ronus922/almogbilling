import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { query, withTransaction } from '@/lib/db';
import {
  findUserById,
  countActiveSuperAdminsExcluding,
} from '@/lib/db/users';
import { getDefaultPermissions, canManageRole } from '@/lib/permissions/check';
import { writeAudit } from '@/lib/db/audit';
import type { ModulePermission, Role } from '@/lib/permissions/constants';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  full_name?: unknown;
  role?: unknown;
  is_active?: unknown;
  allow_google_auth?: unknown;
}

interface PermissionRow {
  module: string;
  can_view: boolean;
  can_edit: boolean;
}

const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'manager', 'viewer', 'super_admin'];

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
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
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const target = await findUserById(id);
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Role-scope guard: an admin may only manage manager/viewer. Touching an admin
  // or super_admin (role change, disable, profile) → 403. super_admin passes.
  if (!canManageRole(actor.role, target.role)) {
    return NextResponse.json(
      { error: 'אין הרשאה לנהל משתמש בתפקיד זה' },
      { status: 403 },
    );
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const wantsFullName = 'full_name' in body;
  const wantsRole = 'role' in body;
  const wantsActive = 'is_active' in body;
  const wantsGoogleAuth = 'allow_google_auth' in body;

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

  let nextGoogleAuth: boolean = target.allow_google_auth;
  if (wantsGoogleAuth) {
    if (typeof body.allow_google_auth !== 'boolean') {
      return NextResponse.json({ error: 'allow_google_auth חייב להיות boolean' }, { status: 400 });
    }
    nextGoogleAuth = body.allow_google_auth;
  }

  // ── Role-assignment scope ───────────────────────────────────────
  // The actor may only assign a role they are allowed to manage. Blocks an
  // admin from promoting a manager/viewer up to admin or super_admin.
  if (wantsRole && nextRole !== target.role && !canManageRole(actor.role, nextRole)) {
    return NextResponse.json(
      { error: 'אין הרשאה להקצות תפקיד זה' },
      { status: 403 },
    );
  }

  // ── Self-protection ─────────────────────────────────────────────
  if (target.id === actor.id && wantsRole && nextRole !== target.role) {
    return NextResponse.json({ error: 'אסור לשנות תפקיד של עצמך' }, { status: 403 });
  }
  if (target.id === actor.id && wantsActive && nextActive === false) {
    return NextResponse.json({ error: 'אסור להשבית את עצמך' }, { status: 403 });
  }

  // ── Last-super-admin guard ──────────────────────────────────────
  // A super_admin may manage other super_admins (demote / disable), but the
  // system must never be left with 0 active super_admins. Demoting or disabling
  // a super_admin when no OTHER active super_admin remains → 403.
  const willDemote = target.role === 'super_admin' && wantsRole && nextRole !== 'super_admin';
  const willDisable = target.role === 'super_admin' && target.is_active && wantsActive && nextActive === false;
  if (willDemote || willDisable) {
    const remaining = await countActiveSuperAdminsExcluding(target.id);
    if (remaining === 0) {
      return NextResponse.json(
        { error: 'לא ניתן להסיר את הסופר אדמין האחרון — חייב להישאר לפחות סופר אדמין פעיל אחד' },
        { status: 403 },
      );
    }
  }

  const roleChanged = nextRole !== target.role;
  const activeChanged = nextActive !== target.is_active;

  await withTransaction(async (client) => {
    await client.query(
      `update public.users
         set full_name = $1, role = $2, is_active = $3, allow_google_auth = $4
         where id = $5`,
      [nextFullName, nextRole, nextActive, nextGoogleAuth, target.id],
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

  await writeAudit({
    actorUserId: actor.id,
    action: 'updated',
    entityType: 'user',
    entityId: target.id,
    changes: {
      before: {
        full_name: target.full_name, role: target.role,
        is_active: target.is_active, allow_google_auth: target.allow_google_auth,
      },
      after: {
        full_name: nextFullName, role: nextRole,
        is_active: nextActive, allow_google_auth: nextGoogleAuth,
      },
    },
    metadata: {
      roleChanged, activeChanged,
      googleAuthChanged: nextGoogleAuth !== target.allow_google_auth,
      actor_role: actor.role,
    },
  });

  const updated = await findUserById(target.id);
  return NextResponse.json({ user: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const target = await findUserById(id);
  if (!target) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Role-scope guard: admin may only disable manager/viewer; never an admin or
  // super_admin. super_admin passes (last-super-admin guard below still applies).
  if (!canManageRole(actor.role, target.role)) {
    return NextResponse.json(
      { error: 'אין הרשאה לנהל משתמש בתפקיד זה' },
      { status: 403 },
    );
  }

  if (target.id === actor.id) {
    return NextResponse.json({ error: 'אסור להשבית את עצמך' }, { status: 403 });
  }

  if (target.role === 'super_admin') {
    const remaining = await countActiveSuperAdminsExcluding(target.id);
    if (remaining === 0) {
      return NextResponse.json(
        { error: 'לא ניתן להסיר את הסופר אדמין האחרון — חייב להישאר לפחות סופר אדמין פעיל אחד' },
        { status: 403 },
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

  await writeAudit({
    actorUserId: actor.id,
    action: 'disabled',
    entityType: 'user',
    entityId: target.id,
    metadata: { email: target.email, role: target.role, actor_role: actor.role },
  });

  return NextResponse.json({ ok: true });
}
