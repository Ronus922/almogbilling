import type { QueryResult, QueryResultRow } from 'pg';
import type { CreateNotificationInput, Notification } from '@/lib/types/tasks';

// The two notification statements a process OUTSIDE Next also needs — the
// delivery worker raises the SMTP auth alert (src/lib/email/smtp-auth-alert.ts)
// over its own pool. No 'server-only' here; src/lib/db/notifications.ts and
// src/lib/db/users.ts wrap these with the app's pool, so there is one SQL text.

interface SqlRunner {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export const NOTIFICATION_COLUMNS = `
  id, user_id, type, title, message, is_read, read_at, cleared_at,
  source_module, source_entity_type, source_entity_id,
  action_url, priority, dedupe_key, created_at, updated_at
`;

/**
 * Insert a notification. When dedupeKey is supplied we ON CONFLICT DO NOTHING
 * against the partial unique index — a repeated assignment won't spam the user.
 * Returns the created row, or null when it was deduped away.
 */
export async function insertNotificationRow(
  db: SqlRunner,
  input: CreateNotificationInput,
): Promise<Notification | null> {
  const r = await db.query<Notification>(
    `insert into public.notifications
       (user_id, type, title, message, source_module, source_entity_type,
        source_entity_id, action_url, priority, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning ${NOTIFICATION_COLUMNS}`,
    [
      input.userId,
      input.type,
      input.title,
      input.message ?? null,
      input.sourceModule ?? null,
      input.sourceEntityType ?? null,
      input.sourceEntityId ?? null,
      input.actionUrl ?? null,
      input.priority ?? 'normal',
      input.dedupeKey ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

/** Active super_admin + admin users — recipients of system-wide notifications
 *  (e.g. an inbound WhatsApp message, the SMTP auth alert). id + name only. */
export async function selectActiveAdmins(db: SqlRunner): Promise<{ id: string; name: string }[]> {
  const r = await db.query<{ id: string; full_name: string | null; username: string }>(
    `select id, full_name, username
       from public.users
      where is_active = true and role in ('super_admin', 'admin')
      order by created_at asc`,
  );
  return r.rows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));
}
