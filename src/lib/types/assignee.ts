// Shared "handler" (גורם מטפל) types for the mutually-exclusive assignee model:
// an entity (issue / task) is handled by EITHER an internal user OR an external
// supplier — never both. Consumed by the shared <AssigneeField> component, the
// shared assertSingleAssignee validation helper, and the issues/tasks modules.

export type AssigneeType = 'none' | 'user' | 'supplier';

/** Internal-user option for the picker. */
export interface AssigneeOption {
  id: string;
  name: string;
}

/** Supplier option for the picker + filter (subset of a supplier).
 *  Promoted from the issue-specific IssueSupplierOption — now shared. */
export interface SupplierOption {
  id: string;
  display_name: string;
  phone: string;
}

/** Controlled value of <AssigneeField> — the type plus the chosen id per type. */
export interface AssigneeValue {
  type: AssigneeType;
  userId: string | null;
  supplierId: string | null;
}
