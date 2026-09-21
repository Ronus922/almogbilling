// Client-safe (NO `server-only`): the debt-amount audience filter's ("רק מי
// שחייב" / "מעל ₪", Section 4) shared validation rule + message. Used both by
// the compose screen's inline check (BroadcastComposeClient.tsx, BEFORE the
// request is even sent) and the server routes' 400 (campaigns /
// audience-count, via parseBroadcastDebtFilter in whatsapp-broadcast.ts) — one
// place so the two can never disagree about what counts as a valid amount.

export const MIN_DEBT_AMOUNT_ERROR = 'הסכום ב"מעל ₪" חייב להיות מספר לא שלילי';

/** null = "any positive debt" (valid — the amount field was left empty). A
 *  non-negative finite number is valid. Anything else (negative, NaN,
 *  Infinity, a non-number) is invalid. */
export function isValidMinDebtAmount(amount: unknown): amount is number | null {
  if (amount === null) return true;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
}
