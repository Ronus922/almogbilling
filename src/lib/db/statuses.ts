import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { LegalStatus } from '@/types/tenant';
import type { StatusFormValue } from '@/lib/validation/status';

export interface StatusRowWithEmails extends LegalStatus {
  notification_emails: string[] | null;
}

// Full row as exposed to admin UI (/statuses) and the linked-debtor count.
// `notification_emails` is the raw text[] from DB; UI converts to CSV.
export interface StatusAdminRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  is_default: boolean;
  is_active: boolean;
  is_system: boolean;
  sort_order: number;
  notification_emails: string[] | null;
  linked_count: number;
  created_at: string;
  updated_at: string;
}

export interface LinkedDebtorRow {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  total_debt: number;
}

const COLUMNS = `id, name, description, color, is_default, is_active, sort_order`;
const COLUMNS_INTERNAL = `${COLUMNS}, notification_emails`;

// ─── Reads (panel + dropdowns) ──────────────────────────────────────────

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

// ─── Reads (admin /statuses screen) ─────────────────────────────────────

// includeInactive=true → all rows (admin screen). false → active only (default,
// preserves the contract used by the tenant-detail-panel).
// linked_count counts non-archived debtors only — matches the toolbar metric
// the user actually cares about.
export async function listStatusesWithCounts(
  includeInactive: boolean,
): Promise<StatusAdminRow[]> {
  const where = includeInactive ? '' : 'where s.is_active = true';
  const r = await query<StatusAdminRow>(
    `select s.id, s.name, s.description, s.color, s.is_default, s.is_active,
            s.is_system, s.sort_order, s.notification_emails,
            s.created_at, s.updated_at,
            coalesce(count(d.id) filter (where d.is_archived = false), 0)::int as linked_count
       from public.statuses s
       left join public.debtors d on d.legal_status_id = s.id
       ${where}
       group by s.id
       order by s.is_system desc, s.sort_order asc, s.name asc`,
  );
  return r.rows;
}

// Used by the admin name-clash check before insert/update.
// Case-insensitive against the existing unique(name) constraint
// (which is case-sensitive at the DB level).
export async function findStatusByLowerName(
  lowerName: string,
  excludeId: string | null,
): Promise<{ id: string } | null> {
  if (excludeId) {
    return queryOne<{ id: string }>(
      `select id from public.statuses
        where lower(name) = lower($1) and id <> $2
        limit 1`,
      [lowerName, excludeId],
    );
  }
  return queryOne<{ id: string }>(
    `select id from public.statuses where lower(name) = lower($1) limit 1`,
    [lowerName],
  );
}

// ─── Writes (admin only) ────────────────────────────────────────────────

interface AuditMeta { userId: string }

// is_default is intentionally not written here — the column has DEFAULT false,
// and only the seeded system row is allowed to hold the default flag. The
// hotfix removed the per-call clearing transaction.
export async function createStatus(
  v: StatusFormValue,
  meta: AuditMeta,
): Promise<StatusAdminRow> {
  const ins = await query<{ id: string }>(
    `insert into public.statuses
       (name, description, color, is_active, notification_emails, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $6)
     returning id`,
    [
      v.name,
      v.description,
      v.color,
      v.is_active,
      v.notification_emails.length === 0 ? null : v.notification_emails,
      meta.userId,
    ],
  );
  const id = ins.rows[0].id;
  const r = await query<StatusAdminRow>(
    `select s.id, s.name, s.description, s.color, s.is_default, s.is_active,
            s.is_system, s.sort_order, s.notification_emails,
            s.created_at, s.updated_at, 0::int as linked_count
       from public.statuses s where s.id = $1`,
    [id],
  );
  return r.rows[0];
}

// is_default is never updated through this code path — the column is owned by
// the seeded system row.
export async function updateStatus(
  id: string,
  v: StatusFormValue,
  meta: AuditMeta,
): Promise<StatusAdminRow> {
  await query(
    `update public.statuses
        set name = $1,
            description = $2,
            color = $3,
            is_active = $4,
            notification_emails = $5,
            updated_by = $6
      where id = $7`,
    [
      v.name,
      v.description,
      v.color,
      v.is_active,
      v.notification_emails.length === 0 ? null : v.notification_emails,
      meta.userId,
      id,
    ],
  );
  const r = await query<StatusAdminRow>(
    `select s.id, s.name, s.description, s.color, s.is_default, s.is_active,
            s.is_system, s.sort_order, s.notification_emails,
            s.created_at, s.updated_at,
            coalesce(count(d.id) filter (where d.is_archived = false), 0)::int as linked_count
       from public.statuses s
       left join public.debtors d on d.legal_status_id = s.id
       where s.id = $1
       group by s.id`,
    [id],
  );
  return r.rows[0];
}

export async function deleteStatus(id: string): Promise<void> {
  await query(`delete from public.statuses where id = $1`, [id]);
}

export async function countLinkedDebtors(statusId: string): Promise<number> {
  const r = await queryOne<{ c: number }>(
    `select count(*)::int as c
       from public.debtors
      where legal_status_id = $1 and is_archived = false`,
    [statusId],
  );
  return r?.c ?? 0;
}

export async function listDebtorsByStatus(statusId: string): Promise<LinkedDebtorRow[]> {
  const r = await query<LinkedDebtorRow>(
    `select id, apartment_number, owner_name, total_debt
       from public.debtors
      where legal_status_id = $1 and is_archived = false
      order by apartment_number asc
      limit 500`,
    [statusId],
  );
  return r.rows;
}
