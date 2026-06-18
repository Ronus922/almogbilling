// Shared mutual-exclusivity rule for the "handler" (גורם מטפל) model — an entity
// is handled by EITHER an internal user OR an external supplier, never both.
// Pure (no DB, no server-only): used by coerceIssueInput and coerceTaskInput, and
// unit-tested directly.

/** The two handler fields any writable-fields object may carry. */
export interface AssigneeFields {
  assigned_to_user_id?: string | null;
  supplier_id?: string | null;
}

/**
 * Enforce the user-XOR-supplier rule on a partial writable-fields object,
 * IN PLACE:
 *   - both explicitly set (truthy) → returns 'assignee_conflict' (reject).
 *   - otherwise the set side clears the other (added as null even if it wasn't in
 *     the body) — so a partial PATCH that assigns one detaches the other, and the
 *     persisted row always satisfies the rule.
 *   - neither set → untouched.
 * Returns the error code on conflict, or null when ok.
 */
export function assertSingleAssignee(fields: AssigneeFields): 'assignee_conflict' | null {
  const userId = fields.assigned_to_user_id ?? null;
  const supplierId = fields.supplier_id ?? null;
  if (userId && supplierId) return 'assignee_conflict';
  if (supplierId) fields.assigned_to_user_id = null;
  else if (userId) fields.supplier_id = null;
  return null;
}
