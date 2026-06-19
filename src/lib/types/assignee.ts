// Shared assignee types for the mixed many-to-many handler model (גורם מטפל):
// a task/issue is handled by ANY combination of internal users and external
// suppliers, stored in the polymorphic `entity_assignees` junction (migration
// 047). This replaces the old user-XOR-supplier scalar model (AssigneeType /
// AssigneeValue / assertSingleAssignee), which has been retired.

export type EntityType = 'task' | 'issue';
export type AssigneeKind = 'user' | 'supplier';

/** One assignee as read back from the junction (enriched with display name +
 *  contact details so the UI can render it and gauge notification availability). */
export interface AssigneeRef {
  assignee_type: AssigneeKind;
  user_id: string | null;
  supplier_id: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
}

/** One assignee as written by the client: a kind + the target id. */
export interface AssigneeInput {
  assignee_type: AssigneeKind;
  id: string;
}

/** Internal-user option for the picker (+ contact-detail presence for the matrix). */
export interface AssigneeOption {
  id: string;
  name: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
}

/** Supplier option for the picker + filter (+ contact-detail presence). `mobile`
 *  is carried alongside `phone` because the WhatsApp send-side prefers mobile
 *  (coalesce mobile→phone) — the matrix cell availability must mirror that. */
export interface SupplierOption {
  id: string;
  display_name: string;
  phone: string;
  mobile?: string | null;
  email?: string | null;
}
