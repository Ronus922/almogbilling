// Tasks / Notifications / Reminders domain types — Module 1.

import type { TargetType } from './targets';
import type { AssigneeRef } from './assignee';
import type { CadenceKind, ChipStrip } from '@/lib/recurrence/cadence';

// ── Tasks ────────────────────────────────────────────────────────────────
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'normal' | 'high' | 'urgent';

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
  // Handlers (users + suppliers) now live in the entity_assignees junction
  // (migration 047), exposed as `assignees` on TaskWithAssignee — NOT as scalar
  // columns here. The legacy assigned_to_user_id / supplier_id columns remain in
  // the DB (frozen) but the app no longer reads or writes them.
  debtor_id: string | null;
  apartment_number: string | null;
  related_entity_type: RelatedEntityType | null;
  related_entity_id: string | null;
  /** Optional polymorphic target: 'room' → debtors.id, 'area' → areas.id. */
  target_type: TargetType | null;
  target_id: string | null;
  sort_order: number;
  is_archived: boolean;
  completed_at: string | null; // stamped on status→done, cleared when it leaves done
  // Recurrence (migration 067 — SINGLE-ROW model). A recurring task is ONE row:
  // recurrence_id points at its rule and due_date is the CURRENT occurrence.
  // There are no materialized instances, so is_recurring_instance /
  // parent_task_id / occurrence_date are frozen in the DB and not projected here.
  recurrence_id: string | null;
  is_recurring_template: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Everything a list/card needs to render the recurrence of a task, fully
 * resolved server-side. The chips and the label are DERIVED from the rule + its
 * anchor (see lib/recurrence/cadence.ts) — there are no bymonth/bymonthday
 * columns. The per-period counts must be computed on the server because they
 * depend on "today" in Asia/Jerusalem, which has to match between SSR and
 * hydration.
 */
export interface TaskRecurrenceView {
  kind: CadenceKind;
  /** "כל שבוע" / "כל רבעון" / "כל 5 ימים". */
  label: string;
  chips: ChipStrip;
  /** Completed occurrences inside the current period. */
  done_count: number;
  /** Occurrences the rule expects per period; 0 when not meaningful. */
  expected_count: number;
  /** Hebrew period suffix for the progress badge — "השבוע" / "השנה". */
  period_label: string | null;
}

/** Task enriched with its assignee set (json-agg over the junction) + comment count. */
export interface TaskWithAssignee extends Task {
  assignees: AssigneeRef[];
  comment_count: number;
  /** Resolved display label for the optional target (apartment number / area
   *  name), derived in the list/detail query. null when there is no target. */
  target_label: string | null;
  /** Resolved cadence for the recurrence strip; null for one-off tasks. */
  recurrence: TaskRecurrenceView | null;
}

/** One completed occurrence of a recurring task (migration 067). */
export interface TaskOccurrenceCompletion {
  id: string;
  task_id: string;
  occurrence_date: string; // 'YYYY-MM-DD'
  completed_at: string;
  completed_by: string | null;
  completed_by_name: string | null;
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
  debtor_id: string | null;
  related_entity_type: RelatedEntityType | null;
  related_entity_id: string | null;
  target_type: TargetType | null;
  target_id: string | null;
}

export type TaskSort = 'created_desc' | 'due_asc' | 'priority_desc' | 'updated_desc';

export interface TaskListFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedTo?: string;
  supplier_id?: string;
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
  read_at: string | null;
  cleared_at: string | null;
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
  /** CONVENTION: lower_snake_case, matching the entity's table in the singular —
   *  'task', 'issue', 'chat_message', 'conversation', 'calendar_event'. Producers
   *  once wrote 'Task'/'Issue'/'ChatMessage', and a case-sensitive `= 'task'` in
   *  migration 067 then failed to match them, stranding 140 notifications
   *  (cleaned up by 068). Consumers must still compare case-insensitively while
   *  legacy rows in both casings exist. */
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  actionUrl?: string | null;
  priority?: NotificationPriority;
  dedupeKey?: string | null;
}

// ── Reminders ───────────────────────────────────────────────────────────────
// The atomic notification channels a reminder can fire on. Multi-select: a
// reminder carries a non-empty SET of these (see `channels`). The legacy single
// "both" pseudo-channel is retired (→ {in_app,email}); it survives only as a
// possible value of the frozen legacy `channel` column, read via legacyToArray.
export type ReminderChannel = 'in_app' | 'email' | 'whatsapp';

export interface Reminder {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  remind_at: string;
  /** Legacy single channel (frozen column; may still be 'both' on old rows). */
  channel: string;
  /** Multi-select channels (migration 049). Empty/absent → fall back to `channel`. */
  channels: ReminderChannel[] | null;
  /** "אליי"/self opt-in (migration 065) — also notify the owner (user_id). */
  notify_owner: boolean;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateReminderInput {
  entityType: string;
  entityId: string;
  userId: string;
  remindAt: string; // ISO timestamptz
  /** Non-empty set of channels to fire on. */
  channels: ReminderChannel[];
  /** "אליי"/self opt-in (migration 065). Defaults to false when omitted. */
  notifyOwner?: boolean;
}
