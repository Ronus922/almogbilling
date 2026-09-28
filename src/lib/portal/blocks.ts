// Which reference blocks the owners portal renders. The reference screen
// (ref/Tenant Portal.html) carries a personal "my balance" card, a building
// cash-balance KPI and a collection-rate ring; none of them has data behind it
// in this system (decision 28/09/2026 — no personal ledger, no payments, no
// per-apartment figures for residents), so all three are OFF. The markup and
// the grid rules for them are kept in place: switching one on restores the
// reference layout without touching any component.
export const PORTAL_BLOCKS = {
  /** The dark "היתרה שלך לתשלום" card + the pay button (overview, c4). */
  myBalance: false,
  /** The "יתרת קופת הבניין" KPI (overview, first of the three KPIs). */
  cashBalance: false,
  /** The "שיעור גבייה" ring card + the "X מתוך Y דירות שילמו" line. */
  collectionRate: false,
} as const;
