// Which reference blocks the owners portal renders (ref/Tenant Portal.html).
// Two of the three blocks switched off on 28/09/2026 came back the same
// evening once they had data behind them — an owner's own balance (debtors,
// through the session's roster) and the building's month-end bank balance
// (hand-entered per month, behind the "הצג יתרת בנק לדיירים" switch). A block
// that is ON here is still drawn only when its data exists: no bank value or
// switch off → no cash card, and the grid closes the gap.
export const PORTAL_BLOCKS = {
  /** The dark "היתרה שלך לתשלום" card (overview, c4) — the owner's debt. */
  myBalance: true,
  /** The "יתרת קופת הבניין" KPI — shown when the server sends a bank balance. */
  cashBalance: true,
  /** The "שיעור גבייה" ring card + "X מתוך Y דירות שילמו": no data, off. */
  collectionRate: false,
  /** The personal ledger table of "החשבון שלי": no per-payment data, off. */
  ledger: false,
} as const;
