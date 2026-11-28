import { describe, expect, it } from 'vitest';
import {
  CHIP_NOTE_MAX, chipNoteSchema, cleanChipNote, mayWriteChipNote, type ChipNoteWriter,
} from '@/lib/chipOrders/notes';
import {
  chipOrderCollectedBodySchema, chipOrderGuardNoteBodySchema, chipOrderWindowSaveSchema, chipPickupHandoverBodySchema,
} from '@/lib/validation/requests';
import type { Role } from '@/lib/permissions/constants';

// The three notes of a chip order (27/11/2026, Ronen) — the pure half: what a
// note may hold, and who may write which. The routes are checked against a
// database in tests/chip-order-notes-db.test.ts.

const who = (role: Role, canEditChips: boolean, canManageOrders: boolean): ChipNoteWriter => ({ role, canEditChips, canManageOrders });

describe('a note as it is stored', () => {
  it('plain text: trimmed, line breaks kept (\\r\\n → \\n), control characters removed, empty → null', () => {
    expect(cleanChipNote('  למסור למשה  ')).toBe('למסור למשה');
    expect(cleanChipNote('שורה א\r\nשורה ב')).toBe('שורה א\nשורה ב');
    expect(cleanChipNote('a\u0000b\u0007c\u001Bd')).toBe('abcd');
    expect(cleanChipNote('   ')).toBeNull();
    expect(cleanChipNote('')).toBeNull();
    expect(cleanChipNote(null)).toBeNull();
    expect(cleanChipNote(undefined)).toBeNull();
    // Markup is text like any other: stored as typed, escaped by React on screen.
    expect(cleanChipNote('<b>x</b>')).toBe('<b>x</b>');
  });

  it(`the server's schema: up to ${CHIP_NOTE_MAX} characters after trimming; longer is refused with the note's own label; missing = not sent`, () => {
    const s = chipNoteSchema('הערה לשומר');
    expect(s.safeParse('א'.repeat(CHIP_NOTE_MAX)).success).toBe(true);
    expect(s.safeParse(`  ${'א'.repeat(CHIP_NOTE_MAX)}  `).success).toBe(true);
    const long = s.safeParse('א'.repeat(CHIP_NOTE_MAX + 1));
    expect(long.success).toBe(false);
    expect(long.error?.issues[0]?.message).toContain('הערה לשומר');
    expect(s.safeParse(null)).toMatchObject({ success: true, data: null });
    expect(s.safeParse(undefined)).toMatchObject({ success: true, data: undefined });
    expect(s.safeParse(42).success).toBe(false);
  });

  it('every route that takes a note checks it: the window save, the guard note, "נמסר" and "נאסף"', () => {
    const long = 'x'.repeat(CHIP_NOTE_MAX + 1);
    expect(chipOrderWindowSaveSchema.safeParse({ holders: [], guard_note: long }).success).toBe(false);
    expect(chipOrderWindowSaveSchema.safeParse({ holders: [], guard_note: 'להתקשר' }).success).toBe(true);
    expect(chipOrderGuardNoteBodySchema.safeParse({ guard_note: long }).success).toBe(false);
    expect(chipPickupHandoverBodySchema.safeParse({ person: 'orderer', delivery_note: long }).success).toBe(false);
    expect(chipPickupHandoverBodySchema.safeParse({ person: 'orderer', delivery_note: 'נמסר לבת' }).success).toBe(true);
    expect(chipPickupHandoverBodySchema.safeParse({ person: 'orderer' }).success).toBe(true);
    expect(chipOrderCollectedBodySchema.safeParse({ delivery_note: long }).success).toBe(false);
    expect(chipOrderCollectedBodySchema.safeParse({}).success).toBe(true);
  });
});

describe('who may write which note', () => {
  it('the orderer\'s note: only the public form — no signed-in user, of any role', () => {
    for (const role of ['super_admin', 'admin', 'manager', 'viewer', 'guard'] as Role[]) {
      expect(mayWriteChipNote('orderer', who(role, true, true)), role).toBe(false);
    }
  });

  it('the guard note: whoever prepares or issues chips (chips:edit + chips_orders_manage:edit) — never the guard', () => {
    expect(mayWriteChipNote('guard', who('super_admin', true, true))).toBe(true);
    expect(mayWriteChipNote('guard', who('admin', true, true))).toBe(true);
    expect(mayWriteChipNote('guard', who('manager', true, true))).toBe(true);
    expect(mayWriteChipNote('guard', who('manager', true, false))).toBe(false);
    expect(mayWriteChipNote('guard', who('manager', false, true))).toBe(false);
    expect(mayWriteChipNote('guard', who('viewer', false, false))).toBe(false);
    // Even if a guard were ever given the chips permissions.
    expect(mayWriteChipNote('guard', who('guard', true, true))).toBe(false);
    expect(mayWriteChipNote('guard', who('guard', false, false))).toBe(false);
  });

  it('the delivery note: whoever hands over — the pickup screen\'s roles (guard, admin, super admin) or staff who mark "נאסף"', () => {
    expect(mayWriteChipNote('delivery', who('guard', false, false))).toBe(true);
    expect(mayWriteChipNote('delivery', who('admin', false, false))).toBe(true);
    expect(mayWriteChipNote('delivery', who('super_admin', false, false))).toBe(true);
    expect(mayWriteChipNote('delivery', who('manager', false, true))).toBe(true);
    expect(mayWriteChipNote('delivery', who('manager', true, false))).toBe(false);
    expect(mayWriteChipNote('delivery', who('viewer', false, false))).toBe(false);
  });
});
