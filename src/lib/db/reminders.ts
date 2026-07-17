import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { PoolClient } from 'pg';
import type { CreateReminderInput, Reminder } from '@/lib/types/tasks';

const COLUMNS = `
  id, entity_type, entity_id, user_id, remind_at, channel, channels, notify_owner, sent_at, created_at, updated_at
`;

type Queryable = Pick<PoolClient, 'query'>;

export async function createReminder(
  input: CreateReminderInput,
  client?: Queryable,
): Promise<Reminder> {
  const channels = input.channels.length > 0 ? input.channels : ['in_app'];
  // `channel` is the frozen legacy column (NOT NULL, dropped in a later
  // migration) — write a representative value so it stays valid; the engine
  // reads `channels`.
  const params = [
    input.entityType,
    input.entityId,
    input.userId,
    input.remindAt,
    channels[0],
    channels,
    input.notifyOwner ?? false,
  ];
  const sql = `
    insert into public.reminders (entity_type, entity_id, user_id, remind_at, channel, channels, notify_owner)
    values ($1, $2, $3, $4, $5, $6, $7)
    returning ${COLUMNS}
  `;
  if (client) {
    const r = await client.query<Reminder>(sql, params);
    if (!r.rows[0]) throw new Error('failed_to_create_reminder');
    return r.rows[0];
  }
  const row = await queryOne<Reminder>(sql, params);
  if (!row) throw new Error('failed_to_create_reminder');
  return row;
}

/** Reminders attached to a single entity (e.g. a task), newest first. */
export async function listRemindersForEntity(
  entityType: string,
  entityId: string,
): Promise<Reminder[]> {
  const r = await query<Reminder>(
    `select ${COLUMNS}
       from public.reminders
      where entity_type = $1 and entity_id = $2
      order by remind_at asc`,
    [entityType, entityId],
  );
  return r.rows;
}

/** Delete a reminder. Used by the task panel to remove a reminder. */
export async function deleteReminder(id: string): Promise<boolean> {
  const r = await query(`delete from public.reminders where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Delete all reminders for an entity (used when replacing a task's reminders). */
export async function deleteRemindersForEntity(
  entityType: string,
  entityId: string,
  client?: Queryable,
): Promise<void> {
  const sql = `delete from public.reminders where entity_type = $1 and entity_id = $2`;
  if (client) {
    await client.query(sql, [entityType, entityId]);
    return;
  }
  await query(sql, [entityType, entityId]);
}

/** Due, un-sent reminders for the reminders engine. */
export async function listDueReminders(limit = 200): Promise<Reminder[]> {
  const lim = Math.min(Math.max(limit, 1), 1000);
  const r = await query<Reminder>(
    `select ${COLUMNS}
       from public.reminders
      where sent_at is null and remind_at <= now()
      order by remind_at asc
      limit ${lim}`,
  );
  return r.rows;
}

export async function markReminderSent(id: string, client?: Queryable): Promise<void> {
  const sql = `update public.reminders set sent_at = now() where id = $1`;
  if (client) {
    await client.query(sql, [id]);
    return;
  }
  await query(sql, [id]);
}
