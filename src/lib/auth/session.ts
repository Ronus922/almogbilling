import 'server-only';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import {
  SESSION_COOKIE,
  SESSION_LIFETIME_DAYS_REMEMBER,
  SESSION_LIFETIME_HOURS_DEFAULT,
} from '@/lib/constants';

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
}

function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId: string, remember: boolean): Promise<string> {
  const id = newSessionId();
  const lifetimeSec = remember
    ? SESSION_LIFETIME_DAYS_REMEMBER * 24 * 60 * 60
    : SESSION_LIFETIME_HOURS_DEFAULT * 60 * 60;
  const expiresAt = new Date(Date.now() + lifetimeSec * 1000);

  await query(
    `insert into public.sessions (id, user_id, expires_at, remember)
     values ($1, $2, $3, $4)`,
    [id, userId, expiresAt.toISOString(), remember],
  );

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // remember=true → persistent cookie. remember=false → session cookie (no maxAge).
    maxAge: remember ? lifetimeSec : undefined,
  });

  return id;
}

interface SessionRow {
  sid: string;
  user_id: string;
  username: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_admin: boolean;
}

export async function getSession(): Promise<{ sid: string; user: SessionUser } | null> {
  const cookieStore = await cookies();
  const sid = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sid) return null;

  const row = await queryOne<SessionRow>(
    `select s.id as sid, u.id as user_id, u.username, u.email, u.full_name, u.is_active, u.is_admin
     from public.sessions s
     join public.users u on u.id = s.user_id
     where s.id = $1
       and s.expires_at > now()
     limit 1`,
    [sid],
  );

  if (!row || !row.is_active) return null;

  return {
    sid: row.sid,
    user: {
      id: row.user_id,
      username: row.username,
      email: row.email,
      full_name: row.full_name,
      is_admin: row.is_admin,
    },
  };
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  const sid = cookieStore.get(SESSION_COOKIE)?.value;
  if (sid) {
    await query(`delete from public.sessions where id = $1`, [sid]);
  }
  cookieStore.delete(SESSION_COOKIE);
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  await query(`delete from public.sessions where user_id = $1`, [userId]);
}
