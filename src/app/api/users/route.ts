import { NextResponse, type NextRequest } from 'next/server';
import {
  requireAdmin,
  type Actor,
} from '@/lib/auth/actor';
import { canManageRole } from '@/lib/permissions/check';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { writeAudit } from '@/lib/db/audit';
import { query } from '@/lib/db';
import {
  listUsers,
  listOpenInvites,
  emailExistsAsUserOrOpenInvite,
} from '@/lib/db/users';
import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiryFromNow,
} from '@/lib/auth/inviteTokens';
import { sendUserInviteEmail } from '@/services/email';
import { MODULES, ROLES, type Role } from '@/lib/permissions/constants';
import { appUrl } from '@/lib/config';

export const runtime = 'nodejs';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Any real role is a syntactically valid invite target; WHO may actually grant
// each role is enforced per-actor below via canManageRole().
const VALID_ROLES: readonly Role[] = ['super_admin', 'admin', 'manager', 'viewer'];
const VALID_MODULES = new Set(MODULES.map((m) => m.key));

interface CustomPermissionEntry {
  module: string;
  can_view: boolean;
  can_edit: boolean;
}

/**
 * Validate the optional `permissions` array sent at invite time. Returns null
 * (= use role defaults at accept-invite) if the input is missing, malformed,
 * or contains no valid entries. Otherwise returns a sanitized array suitable
 * for storage as JSONB on user_invites.custom_permissions.
 */
function sanitizeCustomPermissions(input: unknown): CustomPermissionEntry[] | null {
  if (!Array.isArray(input)) return null;
  const out: CustomPermissionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { module?: unknown; can_view?: unknown; can_edit?: unknown };
    if (typeof e.module !== 'string' || !VALID_MODULES.has(e.module)) continue;
    if (seen.has(e.module)) continue;
    seen.add(e.module);
    out.push({
      module: e.module,
      can_view: e.can_view === true,
      can_edit: e.can_edit === true,
    });
  }
  return out.length > 0 ? out : null;
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const [users, invites] = await Promise.all([listUsers(), listOpenInvites()]);
  return NextResponse.json({ users, invites });
}

interface PostBody {
  email?: unknown;
  full_name?: unknown;
  role?: unknown;
  permissions?: unknown;
}

export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const full_name = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const role = typeof body.role === 'string' ? (body.role as Role) : '' as Role;

  if (!EMAIL_RX.test(email)) {
    return NextResponse.json({ error: 'כתובת אימייל לא תקינה' }, { status: 400 });
  }
  if (full_name.length < 2 || full_name.length > 80) {
    return NextResponse.json({ error: 'שם מלא חייב להיות 2-80 תווים' }, { status: 400 });
  }
  if (!(VALID_ROLES as readonly string[]).includes(role)) {
    return NextResponse.json({ error: 'תפקיד לא תקין' }, { status: 400 });
  }

  // Server-side role-scope enforcement (never trust the UI):
  //   admin       → may invite manager / viewer only
  //   super_admin → may invite super_admin / admin / manager / viewer
  // canManageRole() returns true for super_admin on any role, and for admin only
  // on manager/viewer — so an admin inviting admin/super_admin gets 403 here.
  if (!canManageRole(actor.role, role)) {
    return NextResponse.json(
      { error: 'אין הרשאה ליצור משתמש בתפקיד זה' },
      { status: 403 },
    );
  }

  if (await emailExistsAsUserOrOpenInvite(email)) {
    return NextResponse.json({ error: 'כתובת המייל כבר רשומה במערכת' }, { status: 409 });
  }

  // Custom permissions only apply to matrix-managed roles. For admin we ignore
  // any permissions sent — admin uses the hardcoded SUPER_ADMIN_ONLY rules.
  const customPermissions = (role === 'manager' || role === 'viewer')
    ? sanitizeCustomPermissions(body.permissions)
    : null;

  const rawToken = generateInviteToken();
  const expiresAt = inviteExpiryFromNow();

  const r = await query<{ id: string }>(
    `insert into public.user_invites (email, full_name, role, token, invited_by, expires_at, custom_permissions)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      email, full_name, role, hashInviteToken(rawToken), actor.id, expiresAt.toISOString(),
      customPermissions ? JSON.stringify(customPermissions) : null,
    ],
  );
  const inviteId = r.rows[0]!.id;

  await writeAudit({
    actorUserId: actor.id,
    action: 'created',
    entityType: 'user_invite',
    entityId: inviteId,
    metadata: { email, full_name, role, actor_role: actor.role },
  });

  const origin = appUrl();
  const acceptUrl = `${origin}/accept-invite?token=${encodeURIComponent(rawToken)}`;
  const inviterName = actor.full_name?.trim() || actor.email;
  const roleLabel = ROLES.find((x) => x.value === role)?.label ?? role;

  try {
    await sendUserInviteEmail(email, {
      inviterName,
      inviteeName: full_name,
      roleLabel,
      acceptUrl,
    });
  } catch (err) {
    console.error('[users POST] invite email failed', err);
    // Keep the invite — admin can use "resend" later.
  }

  return NextResponse.json({ id: inviteId }, { status: 201 });
}
