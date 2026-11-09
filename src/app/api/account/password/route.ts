import { NextResponse } from 'next/server';
import { requireGuardActor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { isValidPassword } from '@/lib/auth/passwordPolicy';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getSession } from '@/lib/auth/session';
import { AUTH_RATE_WINDOW_SEC } from '@/lib/constants';
import { query, queryOne } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import { parseJsonBody } from '@/lib/http/body';
import { changePasswordSchema } from '@/lib/validation/visitors';

export const runtime = 'nodejs';

// POST /api/account/password — a guard changes their OWN password (08/11/2026).
// The system had no such screen for anyone, and a guard has no mailbox for the
// "forgot password" mail, so the visitor-scan screen carries this one action.
// Guard-only on purpose (requireGuardActor): everyone else signs in with an
// address and keeps the existing reset flow; no new surface for them here.
//
// The current password is required, every call counts toward a small attempt
// window (a stolen session must not be able to guess it), and the user's OTHER
// sessions are signed out — this one stays.
const MAX_ATTEMPTS = 5;

export async function POST(req: Request) {
  let actorId: string;
  try {
    actorId = (await requireGuardActor()).id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, changePasswordSchema);
  if (!body.ok) return body.response;
  const { current_password, new_password } = body.data;

  const limit = await checkRateLimit(`pwchange:user:${actorId}`, { max: MAX_ATTEMPTS, windowSec: AUTH_RATE_WINDOW_SEC });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'יותר מדי ניסיונות — נסה שוב בעוד כמה דקות' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const row = await queryOne<{ password_hash: string }>(
    `select password_hash from public.users where id = $1`,
    [actorId],
  );
  // 400, not 401: a 401 reads as "signed out" to the client and would eject the guard.
  if (!row || !(await verifyPassword(current_password, row.password_hash))) {
    return NextResponse.json({ error: 'הסיסמה הנוכחית שגויה' }, { status: 400 });
  }
  if (!isValidPassword(new_password)) {
    return NextResponse.json({ error: 'הסיסמה החדשה לא עומדת בדרישות' }, { status: 400 });
  }
  if (new_password === current_password) {
    return NextResponse.json({ error: 'הסיסמה החדשה זהה לנוכחית' }, { status: 400 });
  }

  const hash = await hashPassword(new_password);
  await query(`update public.users set password_hash = $1, updated_at = now() where id = $2`, [hash, actorId]);

  // Sign out every OTHER session of this user (a lost phone's, a shared tablet's).
  const session = await getSession();
  if (session) {
    await query(`delete from public.sessions where user_id = $1 and id <> $2`, [actorId, session.sid]);
  }

  await writeAudit({
    actorUserId: actorId,
    action: 'updated',
    entityType: 'user',
    entityId: actorId,
    metadata: { passwordChanged: true, self: true },
  });
  return NextResponse.json({ ok: true });
}
