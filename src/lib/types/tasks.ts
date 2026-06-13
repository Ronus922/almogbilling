// Tasks / Notifications / Reminders domain types — Module 1.

// ── Tasks ────────────────────────────────────────────────────────────────
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Generic polymorphic link target. debtor_id stays the primary debtor link;
 *  this is the additive, optional cross-entity reference (migration 028). */
export type RelatedEntityType = 'debtor' | 'building' | 'supplier' | 'contact';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null; // 'YYYY-MM-DD'
  due_time: string | null; // 'HH:MM' / 'HH:MM:SS'
  assigned_to_user_id: string | null;
  debtor_id: string | null;
  apartment_number: string | null;
  related_entity_type: RelatedEntityType | null;
  related_entity_id: string | null;
  sort_order: number;
  is_archived: boolean;
  completed_at: string | null; // stamped on status→done, cleared when it leaves done
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Task enriched with the assignee's display name (LEFT JOIN users). */
export interface TaskWithAssignee extends Task {
  assigned_to_name: string | null;
  comment_count: number;
}

/** Fields a client may write on create/update. All optional on update.
 *  completed_at is NOT here — it's derived server-side from status, never
 *  client-settable. */
export interface TaskWritableFields {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  due_time: string | null;
  assigned_to_user_id: string | null;
  debtor_id: string | null;
  apartment_number: string | null;
  related_entity_type: RelatedEntityType | null;
  related_entity_id: string | null;
}

export type TaskSort = 'created_desc' | 'due_asc' | 'priority_desc' | 'updated_desc';

export interface TaskListFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedTo?: string;
  relatedEntityType?: RelatedEntityType;
  relatedEntityId?: string;
  search?: string;
  sort?: TaskSort;
  includeArchived?: boolean;
}

export interface TaskComment {
  id: string;
  task_id: string;
  content: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskKpis {
  open: number;
  overdue: number;
  doneThisMonth: number;
}

// ── Notifications ──────────────────────────────────────────────────────────
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string | null;
  is_read: boolean;
  source_module: string | null;
  source_entity_type: string | null;
  source_entity_id: string | null;
  action_url: string | null;
  priority: NotificationPriority;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message?: string | null;
  sourceModule?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  actionUrl?: string | null;
  priority?: NotificationPriority;
  dedupeKey?: string | null;
}

// ── Reminders ───────────────────────────────────────────────────────────────
export type ReminderChannel = 'in_app' | 'email' | 'both';

export interface Reminder {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  remind_at: string;
  channel: ReminderChannel;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateReminderInput {
  entityType: string;
  entityId: string;
  userId: string;
  remindAt: string; // ISO timestamptz
  channel?: ReminderChannel;
}
