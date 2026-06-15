import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  ReminderCategory,
  ReminderCategoryWithCount,
  ReminderCategoryWritableFields,
} from '@/lib/types/reminderCategories';

// timestamptz columns cast to text so they cross the RSC boundary as strings
// (matching the declared `string` types) — same convention as userReminders.
const COLUMNS = `
  id, name, color, created_by, display_order, is_archived,
  created_at::text as created_at, updated_at::text as updated_at
`;

const WRITABLE_COLUMNS: (keyof ReminderCategoryWritableFields)[] = [
  'name',
  'color',
  'display_order',
];

// ── List (with open-reminder counts) ─────────────────────────────────────────
/**
 * All non-archived categories (org-wide — created_by is ownership, not a
 * visibility scope), each with its count of non-archived, status='pending'
 * reminders that INVOLVE the given user (created_by = user OR assigned_to =
 * user). Scoping the count to the viewer keeps it consistent with the page's
 * "involving me" reminder list. Ordered by display_order then name.
 */
export async function listReminderCategoriesWithCounts(
  forUserId: string,
): Promise<ReminderCategoryWithCount[]> {
  const r = await query<ReminderCategoryWithCount>(
    `select c.id, c.name, c.color, c.created_by, c.display_order, c.is_archived,
            c.created_at::text as created_at, c.updated_at::text as updated_at,
            coalesce(
              count(rem.id) filter (
                where rem.is_archived = false and rem.status = 'pending'
                  and (rem.created_by = $1 or rem.assigned_to = $1)
              ), 0
            )::int as open_count
       from public.reminder_categories c
       left join public.user_reminders rem on rem.category_id = c.id
      where c.is_archived = false
      group by c.id
      order by c.display_order asc, c.name asc`,
    [forUserId],
  );
  return r.rows;
}

export async function getReminderCategoryById(id: string): Promise<ReminderCategory | null> {
  return queryOne<ReminderCategory>(
    `select ${COLUMNS} from public.reminder_categories where id = $1 limit 1`,
    [id],
  );
}

// ── Create ───────────────────────────────────────────────────────────────────
export async function createReminderCategory(
  data: Partial<ReminderCategoryWritableFields> & { name: string; color: string },
  createdBy: string,
): Promise<ReminderCategory> {
  const rec = data as Record<string, unknown>;
  const cols: string[] = ['created_by'];
  const vals: unknown[] = [createdBy];

  for (const c of WRITABLE_COLUMNS) {
    if (c in rec && rec[c] !== undefined) {
      cols.push(c);
      vals.push(rec[c]);
    }
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const row = await queryOne<ReminderCategory>(
    `insert into public.reminder_categories (${cols.join(', ')})
     values (${placeholders.join(', ')})
     returning ${COLUMNS}`,
    vals,
  );
  if (!row) throw new Error('failed_to_create_reminder_category');
  return row;
}

// ── Update ───────────────────────────────────────────────────────────────────
export async function updateReminderCategory(
  id: string,
  data: Partial<ReminderCategoryWritableFields> & { is_archived?: boolean },
): Promise<ReminderCategory | null> {
  const rec = { ...data } as Record<string, unknown>;
  const set: string[] = [];
  const vals: unknown[] = [id];

  const updatable = [...WRITABLE_COLUMNS, 'is_archived' as const];
  for (const c of updatable) {
    if (c in rec && rec[c] !== undefined) {
      vals.push(rec[c]);
      set.push(`${c} = $${vals.length}`);
    }
  }

  if (set.length === 0) {
    return getReminderCategoryById(id);
  }

  return queryOne<ReminderCategory>(
    `update public.reminder_categories set ${set.join(', ')} where id = $1 returning ${COLUMNS}`,
    vals,
  );
}

// ── Soft-delete ──────────────────────────────────────────────────────────────
/**
 * Soft-delete: archive the category (is_archived = true). Reminders keep their
 * category_id pointing at the archived row; the category simply stops appearing
 * in the active list. Idempotent. Returns false only when the id doesn't exist.
 */
export async function softDeleteReminderCategory(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update public.reminder_categories set is_archived = true where id = $1 returning id`,
    [id],
  );
  return row !== null;
}
