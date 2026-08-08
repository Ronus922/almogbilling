// Pure helpers for the multi-person issue flow (no server imports — unit
// tested in tests/chips-issue-groups.test.ts and shared by the API route and
// the DB layer).

import type { IssueChipGroup, IssueChipsInput } from '@/lib/types/chips';

/** Soft cap of ACTIVE chips per contact — exceeding it requires a non-empty
 *  limit_override_reason (routes map the failure to 422 with a Hebrew message). */
export const ACTIVE_CHIPS_SOFT_LIMIT = 4;

/** Max NEW numbers per group/block in one save. */
export const MAX_CHIPS_PER_GROUP = 5;

/**
 * The soft-limit decision, counted over existing actives + the SUM of all
 * groups' numbers TOGETHER (splitting one holder block into per-type groups
 * never bypasses the count). True → the request must carry an override reason.
 */
export function exceedsSoftLimit(activeCount: number, totalNewNumbers: number): boolean {
  return activeCount + totalNewNumbers > ACTIVE_CHIPS_SOFT_LIMIT;
}

/** Total NEW numbers across all groups (blank entries ignored). */
export function countGroupNumbers(groups: IssueChipGroup[]): number {
  return groups.reduce(
    (sum, g) => sum + g.numbers.filter((n) => n.trim() !== '').length,
    0,
  );
}

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
 * Maps EVERY field: the holder + numbers + app fields become one group; fee /
 * notes / limit_override_reason stay window-global exactly as before — so a
 * legacy request that exceeded the soft limit WITH a reason still passes.
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
  limit_override_reason?: string | null;
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
    limit_override_reason: body.limit_override_reason ?? null,
  };
}
