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
  category_id: string | null; // FK → reminder_categories, nullable (uncategorized)
  completed_at: string | null; // derived from status; stamped on ->done, cleared when leaving done
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

/** Reminder enriched with assignee / creator display names + category meta
 *  (LEFT JOIN users / reminder_categories). category_color drives the card's
 *  colored side-stripe in the UI. */
export interface UserReminderWithNames extends UserReminder {
  assigned_to_name: string | null;
  created_by_name: string | null;
  category_name: string | null;
  category_color: string | null;
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
  category_id: string | null;
}

export interface UserReminderListFilters {
  status?: UserReminderStatus;
  assignedTo?: string;
  /** created_by = this user (the "mine" axis). */
  createdBy?: string;
  /** created_by = this user OR assigned_to = this user (the "involving me" set). */
  involvingUser?: string;
  categoryId?: string;
  entityType?: string;
  entityId?: string;
  /** Only overdue, still-pending reminders (remind_at < now() AND status='pending'). */
  due?: boolean;
  includeArchived?: boolean;
}
