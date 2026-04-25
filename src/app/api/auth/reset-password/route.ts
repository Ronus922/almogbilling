import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { consumeResetToken } from '@/lib/auth/tokens';
import { deleteAllUserSessions } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { token?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token || password.length < 8) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const userId = await consumeResetToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
  }

  const password_hash = await hashPassword(password);
  await query(
    `update public.users set password_hash = $1 where id = $2`,
    [password_hash, userId],
  );

  // Best practice: invalidate all sessions of this user after password reset
  await deleteAllUserSessions(userId);

  return NextResponse.json({ ok: true });
}
