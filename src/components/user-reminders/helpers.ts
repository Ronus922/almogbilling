// Maps server error codes (from /api/user-reminders & /api/reminder-categories)
// to short Hebrew messages for toasts. Unknown codes fall back to a generic.

const MESSAGES: Record<string, string> = {
  // reminders
  title_required: 'יש להזין כותרת',
  title_too_long: 'הכותרת ארוכה מדי',
  remind_at_required: 'יש לבחור תאריך ושעה',
  invalid_remind_at: 'תאריך לא תקין',
  invalid_status: 'סטטוס לא תקין',
  invalid_assigned_to: 'משויך לא תקין',
  invalid_category_id: 'קטגוריה לא תקינה',
  // categories
  name_required: 'יש להזין שם',
  name_too_long: 'השם ארוך מדי',
  color_required: 'יש לבחור צבע',
  invalid_color: 'צבע לא תקין',
  invalid_display_order: 'סדר תצוגה לא תקין',
  // shared
  invalid_reference: 'הפנייה לא תקינה',
  invalid_json: 'בקשה לא תקינה',
  invalid_boolean: 'ערך לא תקין',
  not_found: 'הפריט לא נמצא',
  server_error: 'שגיאת שרת',
};

export function reminderErrorMessage(code?: string | null): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  return 'הפעולה נכשלה';
}

/** Formats an ISO timestamp to a short Hebrew date+time for cards. */
export function formatRemindAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}
