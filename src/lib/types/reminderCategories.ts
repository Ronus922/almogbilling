// Reminder categories — a user-defined, colored taxonomy for the user-facing
// Reminders module (public.reminder_categories, migration 032). Distinct from
// supplier_categories (suppliers panel) and the notification engine.

export interface ReminderCategory {
  id: string;
  name: string;
  color: string; // '#RRGGBB' — user-chosen, stored as data
  created_by: string;
  display_order: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

/** Category enriched with its open-reminder count (for the sidebar list). */
export interface ReminderCategoryWithCount extends ReminderCategory {
  /** Non-archived, status='pending' reminders currently filed under this category. */
  open_count: number;
}

/** Fields a client may write on create/update. */
export interface ReminderCategoryWritableFields {
  name: string;
  color: string;
  display_order: number;
}
