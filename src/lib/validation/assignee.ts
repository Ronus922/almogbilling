// Pure validation/coercion for the mixed many-to-many assignee model
// (entity_assignees junction, migration 047). Replaces the retired
// assertSingleAssignee XOR helper. No DB / server-only — unit-tested directly.

import type { AssigneeInput, AssigneeKind } from '@/lib/types/assignee';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly AssigneeKind[] = ['user', 'supplier'];
const MAX_ASSIGNEES = 50;

export type AssigneesValidation =
  | { ok: true; assignees: AssigneeInput[] }
  | { ok: false; error: string };

/**
 * Coerce body.assignees (array of {assignee_type, id}) into a validated,
 * de-duplicated AssigneeInput[].
 *   - key absent → null (PATCH partial: leave the junction untouched).
 *   - explicit null / [] → { ok, assignees: [] } (clear all — opt-in empty).
 *   - any non-array / bad item / bad kind / bad uuid → { ok:false, error }.
 * Mixing users and suppliers is allowed (that is the whole point).
 */
export function coerceAssignees(body: Record<string, unknown>): AssigneesValidation | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'assignees')) return null;
  const raw = body.assignees;
  if (raw === null) return { ok: true, assignees: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_assignees' };
  if (raw.length > MAX_ASSIGNEES) return { ok: false, error: 'too_many_assignees' };

  const out: AssigneeInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'invalid_assignee_item' };
    const rec = item as Record<string, unknown>;
    const kind = typeof rec.assignee_type === 'string' ? rec.assignee_type : '';
    if (!KINDS.includes(kind as AssigneeKind)) return { ok: false, error: 'invalid_assignee_type' };
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!UUID_RE.test(id)) return { ok: false, error: 'invalid_assignee_id' };
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue; // de-dup
    seen.add(key);
    out.push({ assignee_type: kind as AssigneeKind, id });
  }
  return { ok: true, assignees: out };
}
