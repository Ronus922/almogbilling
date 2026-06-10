import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { Role } from '@/lib/permissions/constants';

export interface UserListRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export async function listUsers(): Promise<UserListRow[]> {
  const r = await query<UserListRow>(
    `select id, username, email, full_name, role, is_active, created_at
       from public.users
       order by is_active desc, created_at asc`,
  );
  return r.rows;
}

export interface InviteListRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  expires_at: string;
  created_at: string;
  invited_by: string;
  invited_by_name: string | null;
}

export async function listOpenInvites(): Promise<InviteListRow[]> {
  const r = await query<InviteListRow>(
    `select i.id, i.email, i.full_name, i.role, i.expires_at, i.created_at,
            i.invited_by, u.full_name as invited_by_name
       from public.user_invites i
       left join public.users u on u.id = i.invited_by
       where i.accepted_at is null
         and i.expires_at > now()
       order by i.created_at desc`,
  );
  return r.rows;
}

export async function findUserById(id: string): Promise<UserListRow | null> {
  return queryOne<UserListRow>(
    `select id, username, email, full_name, role, is_active, created_at
       from public.users
       where id = $1
       limit 1`,
    [id],
  );
}

export async function countActiveSuperAdminsExcluding(excludeId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::int as count
       from public.users
       where role = 'super_admin' and is_active = true and id <> $1`,
    [excludeId],
  );
  return Number(row?.count ?? 0);
}

export async function emailExistsAsUserOrOpenInvite(email: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `select
       exists(select 1 from public.users where lower(email) = lower($1))
       or
       exists(
         select 1 from public.user_invites
         where lower(email) = lower($1) and accepted_at is null and expires_at > now()
       ) as exists`,
    [email],
  );
  return Boolean(row?.exists);
}
