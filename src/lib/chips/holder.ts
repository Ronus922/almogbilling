// Single source of truth for DISPLAYING a chip's holder (product rule 3).
// Client-safe (pure, no server imports) — both the UI layer and API mappers go
// through here; nothing else may read holder_name for display.
//
// Registry roles (owner/tenant/operator): the LIVE contacts name wins; the
// issuance snapshot only surfaces as "הונפק בשם: X" when the name changed.
// Snapshot roles (other/staff): the snapshot IS the identity (no registry row).

import type { ChipResidentRole, ChipWithHolder } from '@/lib/types/chips';

export interface ChipHolderView {
  /** Display name — live registry name for registry roles, snapshot otherwise. */
  name: string;
  phone: string | null;
  role: ChipResidentRole;
  /** false for other/staff — rendered as the "לא במרשם" badge. */
  is_registry_linked: boolean;
  /** Live registry name differs from the issuance snapshot → tooltip, not error. */
  name_changed_since_issue: boolean;
  /** The original snapshot, present only when name_changed_since_issue. */
  issued_as_name: string | null;
}

export const SNAPSHOT_ROLES: readonly ChipResidentRole[] = ['other', 'staff'];

export function isSnapshotRole(role: ChipResidentRole): role is 'other' | 'staff' {
  return role === 'other' || role === 'staff';
}

export function resolveChipHolder(chip: ChipWithHolder): ChipHolderView {
  const snapshot = chip.holder_name?.trim() || null;
  if (isSnapshotRole(chip.resident_role)) {
    return {
      name: snapshot ?? '—',
      phone: chip.holder_phone,
      role: chip.resident_role,
      is_registry_linked: false,
      name_changed_since_issue: false,
      issued_as_name: null,
    };
  }
  const live = chip.live_holder_name?.trim() || null;
  const changed = live !== null && snapshot !== null && live !== snapshot;
  return {
    // A registry row wiped since issuance falls back to the snapshot rather
    // than showing an empty holder.
    name: live ?? snapshot ?? '—',
    phone: (chip.live_holder_phone?.trim() || null) ?? chip.holder_phone,
    role: chip.resident_role,
    is_registry_linked: true,
    name_changed_since_issue: changed,
    issued_as_name: changed ? snapshot : null,
  };
}
