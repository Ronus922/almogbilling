import type { AreaType } from '@/lib/types/areas';
import { REMINDER_CATEGORY_COLORS, UNCATEGORIZED_COLOR } from '@/lib/constants/userReminders';

// Area type options (Hebrew labels) — single source for the <Select> and the
// card badge so labels never drift.
export const AREA_TYPES: { value: AreaType; label: string }[] = [
  { value: 'closed_room', label: 'חדר סגור' },
  { value: 'open_space', label: 'מרחב פתוח' },
];

const AREA_TYPE_MAP = new Map(AREA_TYPES.map((t) => [t.value, t.label]));

export function areaTypeLabel(t: AreaType): string {
  return AREA_TYPE_MAP.get(t) ?? t;
}

// Reuse the reminder-category palette for the area color picker (DRY) — the
// picker also accepts any free-form hex, so this is guidance, not a constraint.
export const AREA_COLORS = REMINDER_CATEGORY_COLORS;

// Neutral side-stripe for an area with no color (data-driven, DESIGN.md §2).
export const AREA_NO_COLOR = UNCATEGORIZED_COLOR;
