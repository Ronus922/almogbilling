// User-facing Reminders module — standalone reminder items (backend).
// Distinct from the notification-scheduling engine in @/lib/types/tasks
// (Reminder / CreateReminderInput) which drives public.reminders.

export type UserReminderStatus = 'pending' | 'done' | 'dismissed';

export interface UserReminder {
  id: string;
  title: string;
  remind_at: string; // ISO timestamptz
  status: UserReminderStatus;
  entity_type: string | null;
  entity_id: string | null;
  assigned_to: string | null;
  created_by: string;
  completed_at: string | null; // derived from status; stamped on ->done, cleared when leaving done
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

/** Reminder enriched with assignee / creator display names (LEFT JOIN users). */
export interface UserReminderWithNames extends UserReminder {
  assigned_to_name: string | null;
  created_by_name: string | null;
}

/** Fields a client may write on create/update. All optional on update.
 *  completed_at is NOT here — it's derived server-side from status. */
export interface UserReminderWritableFields {
  title: string;
  remind_at: string;
  status: UserReminderStatus;
  entity_type: string | null;
  entity_id: string | null;
  assigned_to: string | null;
}

export interface UserReminderListFilters {
  status?: UserReminderStatus;
  assignedTo?: string;
  entityType?: string;
  entityId?: string;
  /** Only overdue, still-pending reminders (remind_at < now() AND status='pending'). */
  due?: boolean;
  includeArchived?: boolean;
}
