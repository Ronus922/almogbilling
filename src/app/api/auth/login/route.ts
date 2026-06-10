import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { checkRateLimit, clearRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { AUTH_RATE_WINDOW_SEC, LOGIN_MAX_PER_USER, LOGIN_MAX_PER_IP } from '@/lib/constants';

export const runtime = 'nodejs';

interface UserRow {
  id: string;
  password_hash: string;
  is_active: boolean;
}

export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown; remember?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const remember = body.remember === true;

  if (!username || !password) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // Brute-force protection: throttle by IP and by username before any
  // password verification. Either bucket being exhausted blocks the attempt.
  const ipBucket = 'login:ip:' + clientIp(req);
  const userBucket = 'login:user:' + username.toLowerCase();
  const ipLimit = await checkRateLimit(ipBucket, {
    max: LOGIN_MAX_PER_IP,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  const userLimit = await checkRateLimit(userBucket, {
    max: LOGIN_MAX_PER_USER,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  if (!ipLimit.allowed || !userLimit.allowed) {
    const retryAfterSec = Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec);
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  const user = await queryOne<UserRow>(
    `select id, password_hash, is_active
     from public.users
     where lower(username) = lower($1)
     limit 1`,
    [username],
  );

  if (!user || !user.is_active) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // Successful login: clear the user bucket so a legitimate user is never
  // locked out by their own earlier failed attempts.
  await clearRateLimit(userBucket);

  await createSession(user.id, remember);

  return NextResponse.json({ ok: true });
}
