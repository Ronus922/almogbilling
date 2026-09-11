/**
 * User-facing copy for a failed / stale Bllink sync (11/09/2026 wording).
 * Shared by the dashboard banner (server) and the "סנכרן עכשיו" toast (client),
 * so both say exactly the same thing. No technical detail lives here — stage,
 * trigger source and the CRM's message stay in sync_runs / the history panel.
 */
export const SYNC_FAILURE_TITLE = 'הסנכרון מול בלינק נכשל — הנתונים אינם מעודכנים';
export const SYNC_FAILURE_ADVICE =
  'אנא נסה שנית בעוד כמה דקות. אם התקלה ממשיכה להופיע, אנא פנה למנהל המערכת, רונן משולם.';
export const SYNC_LAST_UPDATE_LABEL = 'עדכון אחרון:';
export const SYNC_LAST_UPDATE_NONE = 'אין';
export const SYNC_TECH_DETAILS_LABEL = 'פרטים טכניים';
