// Shared contract for the Status Management slice.
// Used by:
//   - client form (StatusFormSheet) for inline error rendering
//   - server routes (POST /api/statuses, PATCH /api/statuses/[id])
//
// Naming note: at the UI/contract layer everything is `status_id` / `Status`.
// The DB-side mapping to `debtors.legal_status_id` happens only inside SQL
// and the lib/db/statuses.ts helpers — never bubbles up here.

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

export const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What the form sends (CSV string for emails — friendly to <Input>).
// is_default is intentionally NOT here — only the system row ('רגיל') is the
// default and that flag isn't user-controllable. Any extraneous is_default in
// the request payload is ignored by the server.
export interface StatusFormInput {
  name: string;
  description?: string | null;
  color: string;
  is_active: boolean;
  notification_emails: string;
}

// Normalized server-bound shape (array for emails — matches text[] column).
export interface StatusFormValue {
  name: string;
  description: string | null;
  color: string;
  is_active: boolean;
  notification_emails: string[];
}

export function validateStatusForm(
  input: Partial<StatusFormInput>,
): ValidationResult<StatusFormValue> {
  const errors: Record<string, string> = {};

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'שם הסטטוס הוא שדה חובה';
  else if (name.length > 60) errors.name = 'שם הסטטוס ארוך מדי (מקסימום 60 תווים)';

  const color = typeof input.color === 'string' ? input.color.trim() : '';
  if (!color) errors.color = 'יש לבחור צבע';
  else if (!COLOR_HEX_RE.test(color)) errors.color = 'פורמט צבע לא תקין';

  const description =
    typeof input.description === 'string' && input.description.trim() !== ''
      ? input.description.trim()
      : null;

  const is_active = input.is_active !== false; // default true

  const rawEmails = typeof input.notification_emails === 'string'
    ? input.notification_emails
    : '';
  const emailList = rawEmails
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const e of emailList) {
    if (!EMAIL_RE.test(e)) {
      errors.notification_emails = `המייל "${e}" אינו תקין`;
      break;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      description,
      color: color.toLowerCase(),
      is_active,
      notification_emails: emailList,
    },
  };
}

// Helpers for boundary conversion (DB ↔ UI).
export function emailsArrayToCsv(arr: string[] | null | undefined): string {
  if (!arr || arr.length === 0) return '';
  return arr.join(', ');
}
