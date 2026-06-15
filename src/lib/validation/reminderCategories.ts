// Shared validation + coercion for reminder categories — used by both
// POST /api/reminder-categories and PATCH /api/reminder-categories/[id].
//
// - Partial by design: only keys present in the body appear in the result, so
//   a PATCH never nulls a field the client didn't send.
// - name + color are required on create; on update they're only validated if
//   present.
//
// Pure (no DB, no server-only): safe to import anywhere. Reuses COLOR_HEX_RE
// from the statuses validation so the hex contract is single-sourced.

import type { ReminderCategoryWritableFields } from '@/lib/types/reminderCategories';
import { COLOR_HEX_RE } from '@/lib/validation/status';

export type ReminderCategoryValidation =
  | { ok: true; fields: Partial<ReminderCategoryWritableFields> }
  | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function coerceReminderCategoryInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): ReminderCategoryValidation {
  const fields: Partial<ReminderCategoryWritableFields> = {};

  // name — required on create; if present on update must be non-empty.
  if (mode === 'create' || has(body, 'name')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: 'name_required' };
    if (name.length > 60) return { ok: false, error: 'name_too_long' };
    fields.name = name;
  }

  // color — required on create; hex '#RRGGBB'.
  if (mode === 'create' || has(body, 'color')) {
    const color = typeof body.color === 'string' ? body.color.trim() : '';
    if (!color) return { ok: false, error: 'color_required' };
    if (!COLOR_HEX_RE.test(color)) return { ok: false, error: 'invalid_color' };
    fields.color = color.toLowerCase();
  }

  // display_order — optional, integer >= 0.
  if (has(body, 'display_order')) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'invalid_display_order' };
    fields.display_order = n;
  }

  return { ok: true, fields };
}
