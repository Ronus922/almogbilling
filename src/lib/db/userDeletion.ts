import 'server-only';
import { queryOne, withTransaction } from '@/lib/db';

// Permanent deletion of a staff user (06/10/2026) — one transaction, in the
// order the decision fixed:
//   1. the user's name is written beside their id wherever content keeps a
//      name snapshot and the snapshot is still empty;
//   2. the references Postgres would refuse to orphan (FKs with no ON DELETE
//      action) are set to NULL here — the FK constraints themselves are not
//      touched; every other reference declares SET NULL or CASCADE in the
//      schema and the delete itself applies it (assignments on tasks / issues
//      and the entity_assignees rows go that way — counted first, for the
//      audit row and the report);
//   3. sessions, permissions, reset tokens, then the user row.
// Everything the user wrote stays, under their name. There is no separate
// auth record: the password hash lives on public.users (custom auth).

/** Where content keeps the author's name as text beside the id. The first
 *  group already writes the name on insert (nothing to do unless a row
 *  predates that); the last six got their column on 06/10/2026. */
const NAME_SNAPSHOTS: ReadonlyArray<readonly [table: string, idCol: string, nameCol: string]> = [
  ['comments', 'author_id', 'author_name'],
  ['completed_actions', 'completed_by', 'completed_by_name'],
  ['debtor_events', 'actor_id', 'actor_name'],
  ['legal_status_history', 'changed_by', 'changed_by_name'],
  ['debtors', 'legal_status_updated_by', 'legal_status_updated_by_name'],
  ['issues', 'created_by', 'created_by_name'],
  ['issue_comments', 'author_id', 'author_name'],
  ['tasks', 'created_by', 'created_by_name'],
  ['task_comments', 'author_id', 'author_name'],
  ['task_occurrence_completions', 'completed_by', 'completed_by_name'],
  ['internal_messages', 'sender_user_id', 'sender_name'],
  ['internal_conversations', 'created_by', 'created_by_name'],
  ['chips', 'issued_by', 'issued_by_name'],
  ['chips', 'deactivated_by', 'deactivated_by_name'],
  ['chip_events', 'actor_id', 'actor_name'],
  ['suppliers', 'created_by', 'created_by_name'],
  ['supplier_documents', 'uploaded_by', 'uploaded_by_name'],
  ['chat_messages', 'sent_by', 'sent_by_name'],
  ['wa_campaigns', 'created_by', 'created_by_name'],
  ['documents', 'uploaded_by', 'uploaded_by_name'],
  ['document_folders', 'created_by', 'created_by_name'],
  ['user_reminders', 'created_by', 'created_by_name'],
  ['audit_log', 'actor_user_id', 'actor_name'],
];

/** FKs to public.users with no ON DELETE action (Postgres: NO ACTION — the
 *  delete is refused while any of them points at the user). Cleared here,
 *  explicitly; the constraints stay as they are. Five of them were NOT NULL
 *  until migration 20261006063651 loosened them. */
const CLEAR_REFERENCES: ReadonlyArray<readonly [table: string, col: string]> = [
  ['comments', 'author_id'],
  ['completed_actions', 'completed_by'],
  ['contacts', 'created_by'],
  ['debtors', 'legal_status_updated_by'],
  ['document_folders', 'created_by'],
  ['documents', 'uploaded_by'],
  ['legal_status_history', 'changed_by'],
  ['parking_spots', 'created_by'],
  ['parking_spots', 'deactivated_by'],
  ['parking_spots', 'updated_by'],
  ['reminder_categories', 'created_by'],
  ['storage_units', 'created_by'],
  ['storage_units', 'deactivated_by'],
  ['storage_units', 'updated_by'],
  ['user_invites', 'invited_by'],
  ['user_reminders', 'created_by'],
];

const OPEN_ISSUE = `status in ('open', 'in_progress')`;
const OPEN_TASK = `status in ('open', 'in_progress')`;

export interface UserDeletionOutcome {
  /** Open issues / tasks whose single assignee was this user — now unassigned. */
  openIssuesUnassigned: number;
  openTasksUnassigned: number;
  /** Multi-assignee rows (entity_assignees) on open issues / tasks removed with the user. */
  openAssigneeRowsRemoved: number;
  /** Pending reminders assigned to this user — now unassigned. */
  pendingRemindersUnassigned: number;
  /** Rows that got the name written in step 1 (were still null). */
  nameSnapshotsWritten: number;
  /** References set to NULL in step 2. */
  referencesCleared: number;
}

/** How many WhatsApp instances name this user as their nominal (webhook)
 *  owner. The FK cascades — deleting such a user would delete the instance,
 *  its token and the routing of inbound messages — so the route refuses. */
export async function countWhatsappInstancesOwnedBy(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from public.whatsapp_instances where user_id = $1`,
    [userId],
  );
  return row?.n ?? 0;
}

export async function deleteUserPermanently(target: {
  id: string;
  username: string;
  full_name: string | null;
}): Promise<UserDeletionOutcome> {
  const name = (target.full_name ?? '').trim() || target.username;
  return withTransaction(async (client) => {
    // ── 1. the name, wherever it is still missing ──────────────────────────
    let nameSnapshotsWritten = 0;
    for (const [table, idCol, nameCol] of NAME_SNAPSHOTS) {
      const r = await client.query(
        `update public.${table} set ${nameCol} = $2 where ${idCol} = $1 and ${nameCol} is null`,
        [target.id, name],
      );
      nameSnapshotsWritten += r.rowCount ?? 0;
    }
    const participants = await client.query(
      `update public.calendar_event_participants set display_name_cache = $2
        where participant_source = 'user' and participant_id = $1 and display_name_cache is null`,
      [target.id, name],
    );
    nameSnapshotsWritten += participants.rowCount ?? 0;

    // ── what the delete will unassign (the FK SET NULL / CASCADE do it) ─────
    const count = async (sql: string): Promise<number> => {
      const r = await client.query<{ n: number }>(sql, [target.id]);
      return r.rows[0]?.n ?? 0;
    };
    const openIssuesUnassigned = await count(
      `select count(*)::int as n from public.issues where assigned_to_user_id = $1 and ${OPEN_ISSUE}`,
    );
    const openTasksUnassigned = await count(
      `select count(*)::int as n from public.tasks where assigned_to_user_id = $1 and ${OPEN_TASK}`,
    );
    const openAssigneeRowsRemoved = await count(
      `select count(*)::int as n from public.entity_assignees ea
        where ea.user_id = $1
          and ((ea.entity_type = 'issue' and exists (select 1 from public.issues i where i.id = ea.entity_id and i.${OPEN_ISSUE}))
            or (ea.entity_type = 'task' and exists (select 1 from public.tasks t where t.id = ea.entity_id and t.${OPEN_TASK})))`,
    );
    const pendingRemindersUnassigned = await count(
      `select count(*)::int as n from public.user_reminders
        where assigned_to = $1 and status = 'pending' and is_archived = false`,
    );

    // ── 2. the references that would block the delete ──────────────────────
    let referencesCleared = 0;
    for (const [table, col] of CLEAR_REFERENCES) {
      const r = await client.query(`update public.${table} set ${col} = null where ${col} = $1`, [target.id]);
      referencesCleared += r.rowCount ?? 0;
    }

    // ── 3. the account ─────────────────────────────────────────────────────
    await client.query(`delete from public.sessions where user_id = $1`, [target.id]);
    await client.query(`delete from public.user_permissions where user_id = $1`, [target.id]);
    await client.query(`delete from public.password_reset_tokens where user_id = $1`, [target.id]);
    const deleted = await client.query(`delete from public.users where id = $1`, [target.id]);
    if (deleted.rowCount !== 1) throw new Error('user_not_deleted');

    return {
      openIssuesUnassigned,
      openTasksUnassigned,
      openAssigneeRowsRemoved,
      pendingRemindersUnassigned,
      nameSnapshotsWritten,
      referencesCleared,
    };
  });
}
