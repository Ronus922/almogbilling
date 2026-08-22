// The Hebrew phrasing of "this number is already taken", shared by the server
// (ParkingConflictError in lib/db/parking.ts) and the client (the contacts
// panel checks occupancy locally so the user sees the clash before saving).
//
// Pure — no server-only, no DB. It lives here rather than in db/parking.ts
// precisely so the client can render the SAME sentence the API would have
// returned, instead of a second, subtly different translation of the same fact.

import { OWNER_TYPE_LABEL } from '@/lib/constants/parking';
import type { ParkingOwnerType } from '@/lib/types/parking';

export type ParkingRecordKind = 'parking' | 'storage';

/**
 * Grammatical forms per record kind — חניה (f.) vs מחסן (m.). Kept as whole
 * words so no code has to append letters to a Hebrew stem: חניה is feminine and
 * מחסן masculine, and Hebrew final forms change when a letter stops being last
 * (רשום + ה is רשומה, not רשוםה). Concatenation gets this wrong.
 */
const CONFLICT_WORDS: Record<ParkingRecordKind, { noun: string; attached: string; registered: string }> = {
  parking: { noun: 'חניה', attached: 'מוצמדת', registered: 'רשומה' },
  storage: { noun: 'מחסן', attached: 'מוצמד', registered: 'רשום' },
};

/** Who currently holds the number. `owner_type` is widened to string because it
 *  arrives from JSON on the client side. */
export interface ParkingConflictHolder {
  number: string;
  apartment_number: string | null;
  owner_type: string;
}

/** e.g. "חניה 63 כבר מוצמדת לדירה 1234" / "מחסן M-4 כבר רשום בבעלות נציגות". */
export function parkingConflictMessage(
  kind: ParkingRecordKind,
  holder: ParkingConflictHolder,
): string {
  const w = CONFLICT_WORDS[kind];
  const owner = OWNER_TYPE_LABEL[holder.owner_type as ParkingOwnerType] ?? holder.owner_type;
  const where = holder.apartment_number
    ? `${w.attached} לדירה ${holder.apartment_number}`
    : `${w.registered} בבעלות ${owner}`;
  return `${w.noun} ${holder.number} כבר ${where}`;
}
