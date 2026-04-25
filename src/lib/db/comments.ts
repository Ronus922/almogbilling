import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { TenantNote } from '@/types/tenant';

export async function listCommentsByDebtor(
  debtorId: string,
  limit?: number,
): Promise<TenantNote[]> {
  const args: unknown[] = [debtorId];
  let sql = `select id, debtor_id, content, author_id as user_id, author_name, author_email, created_at
               from public.comments
               where debtor_id = $1
               order by created_at desc`;
  if (typeof limit === 'number' && limit > 0) {
    args.push(limit);
    sql += ` limit $${args.length}`;
  }
  const r = await query<TenantNote>(sql, args);
  return r.rows;
}

export interface CreateCommentArgs {
  debtor_id: string;
  apartment_number: string;
  content: string;
  author_id: string | null;
  author_name: string;
  author_email: string | null;
}

export async function createComment(args: CreateCommentArgs): Promise<TenantNote> {
  const row = await queryOne<TenantNote>(
    `insert into public.comments
       (debtor_id, apartment_number, content, author_id, author_name, author_email)
     values ($1,$2,$3,$4,$5,$6)
     returning id, debtor_id, content, author_id as user_id, author_name, author_email, created_at`,
    [
      args.debtor_id,
      args.apartment_number,
      args.content,
      args.author_id,
      args.author_name,
      args.author_email,
    ],
  );
  if (!row) throw new Error('createComment: insert returned no row');
  return row;
}
