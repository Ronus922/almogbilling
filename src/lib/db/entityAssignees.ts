import 'server-only';
import type { PoolClient } from 'pg';
import { query } from '@/lib/db';
import type {
  EntityType,
  AssigneeKind,
  AssigneeInput,
} from '@/lib/types/assignee';

/**
 * Polymorphic many-to-many assignee junction (migration 047). A task or issue
 * can hold N user assignees + M supplier assignees simultaneously — the
 * user-XOR-supplier rule is retired. This module is the single read/write entry
 * point for the junction.
 */
export type { EntityType, AssigneeKind } from '@/lib/types/assignee';

/**
 * SQL expression producing a json `assignees` array for the entity, ordered by
 * created_at — inlined into a list/detail SELECT. `entityType` is a fixed
 * literal and `alias` a controlled identifier (never user input), so direct
 * interpolation is safe. Email/phone resolve from the user OR the supplier so
 * the notification matrix can gauge per-assignee cell availability.
 */
export function assigneesJsonExpr(entityType: EntityType, alias: string): string {
  return `coalesce((
    select json_agg(json_build_object(
      'assignee_type', ea.assignee_type,
      'user_id',       ea.user_id,
      'supplier_id',   ea.supplier_id,
      'display_name',  coalesce(eu.full_name, eu.username, es.display_name),
      'email',         coalesce(eu.email, nullif(es.email, '')),
      'phone',         coalesce(eu.notification_phone, nullif(es.mobile, ''), nullif(es.phone, ''))
    ) order by ea.created_at, ea.id)
    from public.entity_assignees ea
    left join public.users eu     on eu.id = ea.user_id
    left join public.suppliers es on es.id = ea.supplier_id
    where ea.entity_type = '${entityType}' and ea.entity_id = ${alias}.id
  ), '[]'::json) as assignees`;
}

/**
 * EXISTS predicate for a "filter by a single user/supplier" clause — inlined in
 * a WHERE. The caller supplies the positional parameter index for the id.
 */
export function assigneeExistsSql(
  entityType: EntityType,
  alias: string,
  kind: AssigneeKind,
  paramIdx: number,
): string {
  const col = kind === 'user' ? 'user_id' : 'supplier_id';
  return `exists (select 1 from public.entity_assignees ea
    where ea.entity_type = '${entityType}' and ea.entity_id = ${alias}.id
      and ea.${col} = $${paramIdx})`;
}

/** Replace the entity's full assignee set (delete-and-insert) inside a transaction. */
export async function replaceEntityAssignees(
  client: PoolClient,
  entityType: EntityType,
  entityId: string,
  assignees: AssigneeInput[],
  createdBy: string | null,
): Promise<void> {
  await client.query(
    `delete from public.entity_assignees where entity_type = $1 and entity_id = $2`,
    [entityType, entityId],
  );
  const seen = new Set<string>();
  for (const a of assignees) {
    const key = `${a.assignee_type}:${a.id}`;
    if (seen.has(key)) continue; // de-dup within the payload
    seen.add(key);
    await client.query(
      `insert into public.entity_assignees
         (entity_type, entity_id, assignee_type, user_id, supplier_id, created_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing`,
      [
        entityType,
        entityId,
        a.assignee_type,
        a.assignee_type === 'user' ? a.id : null,
        a.assignee_type === 'supplier' ? a.id : null,
        createdBy,
      ],
    );
  }
}

/** Copy all of one entity's assignees onto another (within a transaction). */
export async function copyEntityAssignees(
  client: PoolClient,
  fromType: EntityType,
  fromId: string,
  toType: EntityType,
  toId: string,
  createdBy: string | null,
): Promise<void> {
  await client.query(
    `insert into public.entity_assignees
       (entity_type, entity_id, assignee_type, user_id, supplier_id, created_by)
     select $3, $4, assignee_type, user_id, supplier_id, $5
       from public.entity_assignees
      where entity_type = $1 and entity_id = $2
     on conflict do nothing`,
    [fromType, fromId, toType, toId, createdBy],
  );
}

/** The user-kind assignee ids for an entity — the targets for in-app bells,
 *  reminders, the cron due-soon scan, and assignment-change set-diff. Suppliers
 *  are external (no users row) and are excluded here. */
export async function listEntityUserIds(
  entityType: EntityType,
  entityId: string,
): Promise<string[]> {
  const r = await query<{ user_id: string }>(
    `select user_id from public.entity_assignees
      where entity_type = $1 and entity_id = $2 and user_id is not null`,
    [entityType, entityId],
  );
  return r.rows.map((x) => x.user_id);
}

/** All assignee keys for an entity — `user:<id>` / `supplier:<id>` (users AND
 *  suppliers). The edit-form notification matrix diffs the post-update assignees
 *  against this previous set to find who was NEWLY added; `listEntityUserIds`
 *  (users only) is insufficient because suppliers must also count as "added". */
export async function listEntityAssigneeKeys(
  entityType: EntityType,
  entityId: string,
): Promise<string[]> {
  const r = await query<{ assignee_type: AssigneeKind; user_id: string | null; supplier_id: string | null }>(
    `select assignee_type, user_id, supplier_id from public.entity_assignees
      where entity_type = $1 and entity_id = $2`,
    [entityType, entityId],
  );
  return r.rows.map((x) => `${x.assignee_type}:${x.user_id ?? x.supplier_id ?? ''}`);
}

/** Of the given issue ids, the subset the user is a USER-assignee of. Used by the
 *  reorder route to reject a field worker's batch that references any issue not
 *  theirs (a plain per-item check would be N queries; this is one). */
export async function filterIssueIdsAssignedToUser(
  issueIds: string[],
  userId: string,
): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const r = await query<{ entity_id: string }>(
    `select distinct entity_id from public.entity_assignees
      where entity_type = 'issue' and user_id = $1 and entity_id = any($2::uuid[])`,
    [userId, issueIds],
  );
  return r.rows.map((x) => x.entity_id);
}

/** Delete all junction rows for an entity (issue hard-delete cleanup — entity_id
 *  is polymorphic and has no FK, so it does not cascade on its own). */
export async function deleteEntityAssignees(
  entityType: EntityType,
  entityId: string,
): Promise<void> {
  await query(
    `delete from public.entity_assignees where entity_type = $1 and entity_id = $2`,
    [entityType, entityId],
  );
}
