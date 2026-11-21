// Pure helpers for the multi-person issue flow (no server imports — unit
// tested in tests/chips-issue-groups.test.ts and shared by the API route and
// the DB layer).

import type {
  ChipHolderUpdate,
  ChipResidentRole,
  IssueChipGroup,
  IssueChipsInput,
} from '@/lib/types/chips';

// No limit of active chips per apartment and no override reason (21/11/2026 —
// the old soft limit of 4 is gone).

/** NEW numbers per group/block in ONE save — a bound on the request, not a
 *  quantity rule (21/11/2026: raised from 5; the window shows no limit). */
export const MAX_CHIPS_PER_GROUP = 50;

/** First number repeated within or ACROSS groups (after trim), or null. */
export function findDuplicateNumber(
  groups: IssueChipGroup[],
): { number: string; group_index: number } | null {
  const seen = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    for (const raw of groups[i].numbers) {
      const num = raw.trim();
      if (!num) continue;
      if (seen.has(num)) return { number: num, group_index: i };
      seen.add(num);
    }
  }
  return null;
}

/**
 * Adapter for the pre-groups POST /api/chips body (flat, single holder).
 * Maps every field: the holder + numbers + app fields become one group; fee /
 * notes stay window-global exactly as before. A limit_override_reason a legacy
 * caller still sends is ignored (there is no limit since 21/11/2026).
 * The caller validates enums/values; this only reshapes.
 */
export function legacyChipBodyToInput(body: {
  contact_id: string;
  chip_type: IssueChipGroup['chip_type'];
  chip_numbers: string[];
  resident_role: IssueChipGroup['resident_role'];
  holder_name?: string | null;
  holder_phone?: string | null;
  app_platform?: IssueChipGroup['app_platform'];
  app_invite_status?: IssueChipGroup['app_invite_status'];
  app_expires_at?: string | null;
  issuance_fee?: number | null;
  fee_charged?: boolean;
  notes?: string | null;
}): IssueChipsInput {
  return {
    contact_id: body.contact_id,
    groups: [
      {
        resident_role: body.resident_role,
        holder_name: body.holder_name ?? null,
        holder_phone: body.holder_phone ?? null,
        chip_type: body.chip_type,
        numbers: body.chip_numbers,
        app_platform: body.app_platform ?? null,
        app_invite_status: body.app_invite_status ?? null,
        app_expires_at: body.app_expires_at ?? null,
      },
    ],
    issuance_fee: body.issuance_fee ?? null,
    fee_charged: body.fee_charged ?? false,
    notes: body.notes ?? null,
  };
}


/** The holder snapshot a block was seeded with / currently shows. */
export interface HolderSnapshot {
  name: string | null;
  phone: string | null;
  role: ChipResidentRole | null;
}

/**
 * Holder edits for one block's SAVED chips: the current values are diffed
 * against the values the block was seeded with (not against each chip's own
 * snapshot — a registry chip whose live name drifted from its issuance
 * snapshot must not look "edited" just because the window opened). Only the
 * fields the user actually changed are emitted, one entry per saved chip;
 * an untouched block yields []. Phone must arrive already normalized.
 */
export function holderUpdatesForBlock(
  savedChipIds: readonly string[],
  current: HolderSnapshot,
  orig: HolderSnapshot | null,
): ChipHolderUpdate[] {
  if (savedChipIds.length === 0 || !orig || !current.role) return [];
  const patch: Omit<ChipHolderUpdate, 'id'> = {};
  if ((current.name ?? null) !== (orig.name ?? null)) patch.holder_name = current.name ?? null;
  if ((current.phone ?? null) !== (orig.phone ?? null)) patch.holder_phone = current.phone ?? null;
  if (current.role !== orig.role) patch.resident_role = current.role;
  if (Object.keys(patch).length === 0) return [];
  return savedChipIds.map((id) => ({ id, ...patch }));
}
