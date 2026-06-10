import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { query, queryOne } from '@/lib/db';
import { inviteExpiryFromNow } from '@/lib/auth/inviteTokens';
import { sendUserInviteEmail } from '@/services/email';
import { ROLES, type Role } from '@/lib/permissions/constants';
import { appUrl } from '@/lib/config';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface InviteRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  token: string;
  accepted_at: string | null;
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor;
  try {
    actor = await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const invite = await queryOne<InviteRow>(
    `select id, email, full_name, role, token, accepted_at
       from public.user_invites
       where id = $1
       limit 1`,
    [id],
  );

  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (invite.accepted_at) {
    return NextResponse.json({ error: 'ההזמנה כבר נוצלה' }, { status: 409 });
  }

  const newExpiry = inviteExpiryFromNow();
  await query(
    `update public.user_invites set expires_at = $1 where id = $2`,
    [newExpiry.toISOString(), id],
  );

  const origin = appUrl();
  const acceptUrl = `${origin}/accept-invite?token=${encodeURIComponent(invite.token)}`;
  const inviterName = actor.full_name?.trim() || actor.email;
  const roleLabel = ROLES.find((x) => x.value === invite.role)?.label ?? invite.role;

  try {
    await sendUserInviteEmail(invite.email, {
      inviterName,
      inviteeName: invite.full_name,
      roleLabel,
      acceptUrl,
    });
  } catch (err) {
    console.error('[invites/resend] email failed', err);
    return NextResponse.json({ error: 'שליחת המייל נכשלה' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
