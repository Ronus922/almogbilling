import { NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { getDefaultPermissions } from '@/lib/permissions/check';
import { isValidPassword } from '@/lib/auth/passwordPolicy';
import { hashInviteToken } from '@/lib/auth/inviteTokens';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { ACCEPT_INVITE_MAX_PER_IP, AUTH_RATE_WINDOW_SEC } from '@/lib/constants';
import { MODULES, type ModulePermission, type Role } from '@/lib/permissions/constants';

export const runtime = 'nodejs';

const VALID_MODULES = new Set(MODULES.map((m) => m.key));

interface InviteRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  expires_at: Date;
  accepted_at: Date | null;
  custom_permissions: unknown;
}

/**
 * Convert the JSONB custom_permissions blob from user_invites into the
 * ModulePermission[] shape used for INSERT into user_permissions. Returns
 * null if the blob is missing or malformed — caller should fall back to
 * getDefaultPermissions(role).
 */
function parseCustomPermissions(raw: unknown): ModulePermission[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ModulePermission[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { module?: unknown; can_view?: unknown; can_edit?: unknown };
    if (typeof e.module !== 'string' || !VALID_MODULES.has(e.module)) continue;
    if (seen.has(e.module)) continue;
    seen.add(e.module);
    out.push({
      module: e.module,
      canView: e.can_view === true,
      canEdit: e.can_edit === true,
    });
  }
  return out.length > 0 ? out : null;
}

interface PostBody {
  token?: unknown;
  password?: unknown;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Rate limit by IP to throttle invite-token brute forcing.
  const { allowed, retryAfterSec } = await checkRateLimit('accept-invite:ip:' + clientIp(req), {
    max: ACCEPT_INVITE_MAX_PER_IP,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  if (!token) {
    return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
  }
  if (!isValidPassword(password)) {
    return NextResponse.json({ error: 'הסיסמה לא עומדת בדרישות' }, { status: 400 });
  }

  // Storage is hash-only: look up by the SHA-256 of the raw token from the body.
  const tokenHash = hashInviteToken(token);

  let userId: string;
  try {
    userId = await withTransaction(async (client) => {
      const { rows } = await client.query<InviteRow>(
        `select id, email, full_name, role, expires_at, accepted_at, custom_permissions
           from public.user_invites
           where token = $1
           for update`,
        [tokenHash],
      );
      const invite = rows[0];
      if (!invite) throw new Error('invalid_or_expired_token');
      if (invite.accepted_at) throw new Error('invalid_or_expired_token');
      if (new Date(invite.expires_at).getTime() <= Date.now()) {
        throw new Error('invalid_or_expired_token');
      }

      // Username convention: full email (lowercase). Guarantees uniqueness.
      const username = invite.email.toLowerCase();
      const password_hash = await hashPassword(password);

      // Re-check: the email could already belong to a user (e.g. someone
      // accepted an older invite with the same address). Fail closed.
      const existing = await client.query<{ id: string }>(
        `select id from public.users where lower(username) = lower($1) or lower(email) = lower($1) limit 1`,
        [invite.email],
      );
      if (existing.rows[0]) {
        throw new Error('user_already_exists');
      }

      const insertUser = await client.query<{ id: string }>(
        `insert into public.users (username, email, full_name, password_hash, role, is_active)
         values ($1, $2, $3, $4, $5, true)
         returning id`,
        [username, invite.email, invite.full_name, password_hash, invite.role],
      );
      const newUserId = insertUser.rows[0]!.id;

      // Seed permissions for matrix-managed roles. Use the matrix snapshot
      // saved at invite time (custom_permissions) if present; otherwise fall
      // back to the role defaults — preserving Slice 6 behavior for legacy
      // invites and any invite created without matrix customization.
      if (invite.role === 'manager' || invite.role === 'viewer') {
        const custom = parseCustomPermissions(invite.custom_permissions);
        const permsToSeed = custom ?? getDefaultPermissions(invite.role) ?? [];
        for (const p of permsToSeed) {
          await client.query(
            `insert into public.user_permissions (user_id, module, can_view, can_edit)
             values ($1, $2, $3, $4)`,
            [newUserId, p.module, p.canView, p.canEdit],
          );
        }
      }

      await client.query(
        `update public.user_invites set accepted_at = now() where id = $1`,
        [invite.id],
      );

      return newUserId;
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'invalid_or_expired_token') {
      return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
    }
    if (msg === 'user_already_exists') {
      return NextResponse.json({ error: 'user_already_exists' }, { status: 409 });
    }
    console.error('[accept-invite] failed', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  await createSession(userId, false);
  return NextResponse.json({ ok: true });
}
