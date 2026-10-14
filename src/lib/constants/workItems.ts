// תקלות/משימות — shared card/row visual language (ref: ref/issues-board.html,
// 12/10/2026 pixel-exact adoption, Decisions Log: declared exception to
// DESIGN.md's usual Tailwind-named palette — these are the reference
// mockup's literal hex tokens, kept verbatim rather than approximated to the
// nearest Tailwind shade). Card/row color belongs to PRIORITY only; there is
// no status chip and no kind tag on a card — see DESIGN.md §41.
//
// `--color-ink` / `--color-ink-2` / `--color-ink-3` / `--color-ink-ghost` /
// `--color-line` / `--color-line-soft` / `--color-line-strong` / `--color-
// brand*` / `--color-row-hover` in globals.css already equal the reference's
// ink/border/brand tokens byte-for-byte (shared app-wide theme, predates this
// module) — only the priority/urgent/amber/violet/cyan/green tones below are
// new, module-specific literals.

export const WORK_PRIORITY_CARD: Record<'normal' | 'high' | 'urgent', string> = {
  normal: 'border-line',
  high: 'border-[#FBE4B5] bg-[#FFFBEE]',
  urgent: 'border-[#F8D2D3] bg-[#FFF6F6]',
};

export const WORK_PRIORITY_ROW_HOVER: Record<'normal' | 'high' | 'urgent', string> = {
  normal: 'hover:bg-row-hover',
  high: 'hover:bg-[#FFF6DC]',
  urgent: 'hover:bg-[#FFEEEE]',
};

export const WORK_PRIORITY_LABEL: Record<'normal' | 'high' | 'urgent', string> = {
  normal: 'רגילה',
  high: 'גבוהה',
  urgent: 'דחופה',
};

export const WORK_NEW_TAG = 'bg-brand text-white';
export const WORK_BLOCKED_TAG = 'bg-red-100 text-red-700';
export const WORK_OVERDUE_TEXT = 'text-red-700';
export const WORK_RESIDENT_TEXT = 'text-[#0C7A37]';
export const WORK_RESIDENT_TAG = 'bg-teal-100 text-teal-700';
export const WORK_AVATAR = 'bg-brand-soft text-brand-text';

/** Column-header / lane avatar background — one color per employee, stable
 *  across renders (hash of the id), cycling the reference's palette. White
 *  text on every tone. Suppliers' combined lane always uses the green tone
 *  (matches the reference's "ספקים" column). */
const AVATAR_PALETTE = ['#E5484D', '#7C5CFC', '#0BA5C7', '#E08700', '#3D5AFE', '#16A34A', '#8A92A6'];

export function avatarColorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

export const SUPPLIER_LANE_COLOR = '#16A34A';
export const UNASSIGNED_LANE_COLOR = '#8A92A6';

/** Sentinel lane id for the combined "ספקים" board column — lives alongside
 *  real employee uuids inside public.user_work_board_order.employee_ids
 *  (14/10/2026, "התאמת לוח — ספקים + בחירה מפורשת גוברת"), so it can be
 *  pinned/hidden/reordered through the exact same mechanism as an employee
 *  lane. Never a valid uuid, so it can never collide with a real id. */
export const SUPPLIERS_LANE_ID = 'suppliers';
