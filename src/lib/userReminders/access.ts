// Row-level access to a user reminder — the one source of "who is this actor
// to this reminder", for the routes AND the page (06/10/2026).
//
// The permission matrix (user_reminders:view / :edit) says whether a role may
// use the module at all; it says nothing about WHICH reminders. A reminder is
// personal: it belongs to the person who wrote it, and is shared with the one
// it is assigned to. So:
//   • read  — the creator and the assignee, nobody else (the list is always
//     the actor's own set; a single GET of someone else's reminder is 404);
//   • edit / delete — the creator alone;
//   • the assignee may change the STATUS and nothing else — "סמן כהושלם"
//     from the card and the status select in the panel, the one write an
//     assignee legitimately made before this rule (Phase 0, 06/10/2026).
// Pure (no DB, no server-only): the client gates its buttons with the same
// function the routes refuse with.

export type ReminderRole = 'creator' | 'assignee' | 'none';

/** Who `actorId` is to the reminder. A deleted creator (created_by NULL since
 *  06/10/2026) is nobody's: the assignee keeps their status write, no one
 *  edits. */
export function reminderRole(
  actorId: string,
  r: { created_by: string | null; assigned_to: string | null },
): ReminderRole {
  if (r.created_by !== null && r.created_by === actorId) return 'creator';
  if (r.assigned_to !== null && r.assigned_to === actorId) return 'assignee';
  return 'none';
}

/** The only body keys an assignee may send to PATCH. */
export const ASSIGNEE_PATCH_FIELDS: ReadonlySet<string> = new Set(['status']);

/** Whether a PATCH with these body keys is within what `role` may change. */
export function reminderPatchAllowed(role: ReminderRole, bodyKeys: readonly string[]): boolean {
  if (role === 'creator') return true;
  if (role === 'assignee') return bodyKeys.every((k) => ASSIGNEE_PATCH_FIELDS.has(k));
  return false;
}
