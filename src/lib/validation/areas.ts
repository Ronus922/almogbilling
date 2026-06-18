// Shared validation + coercion for the Areas module — used by both
// POST /api/areas and PATCH /api/areas/[id] (single source of truth).
//
// Pure (no DB, no server-only). Reuses COLOR_HEX_RE from the statuses
// validation so the hex contract is single-sourced.

import type { AreaType, AreaWritableFields } from '@/lib/types/areas';
import { COLOR_HEX_RE } from '@/lib/validation/status';

export const AREA_NAME_MAX = 120;
export const AREA_DESCRIPTION_MAX = 2000;

const AREA_TYPES: readonly AreaType[] = ['closed_room', 'open_space'];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export type AreaValidation =
  | { ok: true; fields: AreaWritableFields }
  | { ok: false; error: string };

/**
 * Coerce arbitrary JSON into a validated AreaWritableFields. Error codes:
 * name_required / name_too_long / area_type_required / invalid_area_type /
 * description_too_long / invalid_color.
 */
export function coerceAndValidateArea(body: Record<string, unknown>): AreaValidation {
  const name = str(body.name);
  if (!name) return { ok: false, error: 'name_required' };
  if (name.length > AREA_NAME_MAX) return { ok: false, error: 'name_too_long' };

  const typeRaw = str(body.area_type);
  if (!typeRaw) return { ok: false, error: 'area_type_required' };
  if (!AREA_TYPES.includes(typeRaw as AreaType)) {
    return { ok: false, error: 'invalid_area_type' };
  }
  const area_type = typeRaw as AreaType;

  const descriptionRaw = str(body.description);
  if (descriptionRaw.length > AREA_DESCRIPTION_MAX) {
    return { ok: false, error: 'description_too_long' };
  }
  const description: string | null = descriptionRaw || null;

  // Optional card color — hex '#RRGGBB' or null.
  const colorRaw = str(body.color);
  let color: string | null = null;
  if (colorRaw) {
    if (!COLOR_HEX_RE.test(colorRaw)) return { ok: false, error: 'invalid_color' };
    color = colorRaw.toLowerCase();
  }

  return {
    ok: true,
    fields: { name, area_type, description, color },
  };
}
