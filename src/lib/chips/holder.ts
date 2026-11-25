// Single source of truth for DISPLAYING a chip's holder (product rule 3).
// Client-safe (pure, no server imports) — both the UI layer and API mappers go
// through here; nothing else may read holder_name for display.
//
// Registry roles (owner/tenant/operator): the LIVE contacts name wins; the
// issuance snapshot only surfaces as "הונפק בשם: X" when the name changed.
// Snapshot roles (other/staff): the snapshot IS the identity (no registry row).

import type { ChipLeaseRef, ChipResidentRole, ChipWithHolder } from '@/lib/types/chips';

/** The email, the lease and its end date as a person's chips hold them
 *  (25/11/2026) — the first chip that has each. What the holder's block of the
 *  issue window is seeded with, and what the holder's own panel shows. */
export function chipHolderDetails(
  chips: Pick<ChipWithHolder, 'holder_email' | 'lease_file_key' | 'lease_file_name' | 'lease_end_date'>[],
): { email: string | null; lease: ChipLeaseRef | null; leaseEnd: string | null } {
  const leased = chips.find((c) => c.lease_file_key && c.lease_file_name);
  return {
    email: chips.find((c) => c.holder_email)?.holder_email ?? null,
    lease: leased ? { key: leased.lease_file_key as string, name: leased.lease_file_name as string, mime: null, size: null } : null,
    leaseEnd: (leased?.lease_end_date ?? chips.find((c) => c.lease_end_date)?.lease_end_date) ?? null,
  };
}

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
