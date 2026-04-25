import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { LegalStatus } from '@/types/tenant';

export interface StatusRowWithEmails extends LegalStatus {
  notification_emails: string[] | null;
}

const COLUMNS = `id, name, description, color, is_default, is_active, sort_order`;
const COLUMNS_INTERNAL = `${COLUMNS}, notification_emails`;

export async function listActiveStatuses(): Promise<LegalStatus[]> {
  const r = await query<LegalStatus>(
    `select ${COLUMNS}
       from public.statuses
       where is_active = true
       order by sort_order asc, name asc`,
  );
  return r.rows;
}

export async function getStatusById(id: string): Promise<StatusRowWithEmails | null> {
  return queryOne<StatusRowWithEmails>(
    `select ${COLUMNS_INTERNAL}
       from public.statuses
       where id = $1`,
    [id],
  );
}

export async function getDefaultStatusId(): Promise<string | null> {
  const r = await queryOne<{ id: string }>(
    `select id from public.statuses where is_default = true limit 1`,
  );
  return r?.id ?? null;
}
