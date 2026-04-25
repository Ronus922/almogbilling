import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

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

  await createSession(user.id, remember);

  return NextResponse.json({ ok: true });
}
