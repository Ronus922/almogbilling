// Shared validation + coercion for the Issues module — used by both
// POST /api/issues and PATCH /api/issues/[id] (single source of truth).
//
// - Partial by design: only keys present in the body appear in the result, so
//   a PATCH never nulls a field the client didn't send.
// - title is required on create, validated-only-if-present on update.
// - Pure (no DB, no server-only): safe to import anywhere.

import type {
  IssueLocationType,
  IssuePriority,
  IssueStatus,
  IssueWritableFields,
} from '@/lib/types/issues';

const STATUSES: readonly IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES: readonly IssuePriority[] = ['low', 'normal', 'high', 'urgent'];
const LOCATION_TYPES: readonly IssueLocationType[] = ['apartment', 'area', 'general'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `id` is a well-formed UUID. Used by routes to reject malformed
 * `[id]` params before they hit a uuid-typed query (avoids a Postgres 22P02
 * → unhandled 500; returns a clean 400/404 instead). */
export function isUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export type IssueValidation =
  | { ok: true; fields: Partial<IssueWritableFields> }
  | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function coerceIssueInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): IssueValidation {
  const fields: Partial<IssueWritableFields> = {};

  // title — required on create; if present on update must be non-empty.
  if (mode === 'create' || has(body, 'title')) {
    const title = strOrNull(body.title);
    if (!title) return { ok: false, error: 'title_required' };
    if (title.length > 300) return { ok: false, error: 'title_too_long' };
    fields.title = title;
  }

  if (has(body, 'description')) {
    const d = strOrNull(body.description);
    if (d && d.length > 20000) return { ok: false, error: 'description_too_long' };
    fields.description = d;
  }

  if (has(body, 'location_type')) {
    const lt = strOrNull(body.location_type);
    if (!lt || !LOCATION_TYPES.includes(lt as IssueLocationType)) {
      return { ok: false, error: 'invalid_location_type' };
    }
    fields.location_type = lt as IssueLocationType;
  }

  if (has(body, 'location_text')) {
    const t = strOrNull(body.location_text);
    if (t && t.length > 200) return { ok: false, error: 'location_text_too_long' };
    fields.location_text = t;
  }

  if (has(body, 'status')) {
    const s = strOrNull(body.status);
    if (!s || !STATUSES.includes(s as IssueStatus)) {
      return { ok: false, error: 'invalid_status' };
    }
    fields.status = s as IssueStatus;
  }

  if (has(body, 'priority')) {
    const p = strOrNull(body.priority);
    if (!p || !PRIORITIES.includes(p as IssuePriority)) {
      return { ok: false, error: 'invalid_priority' };
    }
    fields.priority = p as IssuePriority;
  }

  if (has(body, 'resolution_notes')) {
    const r = strOrNull(body.resolution_notes);
    if (r && r.length > 20000) return { ok: false, error: 'resolution_notes_too_long' };
    fields.resolution_notes = r;
  }

  if (has(body, 'assigned_to_user_id')) {
    const id = strOrNull(body.assigned_to_user_id);
    if (id !== null && !UUID_RE.test(id)) return { ok: false, error: 'invalid_assigned_to_user_id' };
    fields.assigned_to_user_id = id;
  }

  // Business rule: closing as 'resolved' requires resolution notes.
  // Validated only when the effective status after this write is 'resolved'.
  if (fields.status === 'resolved') {
    const hasNotesInPatch = has(body, 'resolution_notes') && !!strOrNull(body.resolution_notes);
    if (mode === 'create' && !hasNotesInPatch) {
      return { ok: false, error: 'resolution_notes_required' };
    }
    // On update we cannot see the existing notes here (pure fn); the route
    // layer enforces the "must have notes" rule against the persisted row.
  }

  return { ok: true, fields };
}
