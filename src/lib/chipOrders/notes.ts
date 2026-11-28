import { z } from 'zod';
import { CHIP_PICKUP_ROLES, type Role } from '@/lib/permissions/constants';

// The three notes of a chip order (27/11/2026, Ronen) — the pure, client-safe
// half. Each is its own column, its own label, and has its own writers:
//   · "הערת המזמין" (orderer_note) — the notes field of the public form. Only
//     the form writes it; the staff read it.
//   · "הערה לשומר" (guard_note) — whoever prepares or issues the chips: a user
//     who may edit chips AND manage chip orders, never the guard. Until the
//     order is handed over.
//   · "הערת מסירה" (delivery_note) — whoever hands the chips over: the guard's
//     "נמסר" on the pickup screen, or the staff's "נאסף".
// The staff's own internal note (internal_note, "הערה" of the issue window)
// is none of them and never reaches the guard.
// All three: plain text, trimmed, at most CHIP_NOTE_MAX characters — checked
// on the server (chipNoteSchema) and by a CHECK of the table; React escapes
// them on every screen.

export const CHIP_NOTE_MAX = 500;

export const ORDERER_NOTE_LABEL = 'הערת המזמין';
export const GUARD_NOTE_LABEL = 'הערה לשומר';
export const DELIVERY_NOTE_LABEL = 'הערת מסירה';

export type ChipNoteKind = 'orderer' | 'guard' | 'delivery';

// Control characters other than a line break or a tab — never part of a note.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** A note as it is stored: control characters removed, line breaks kept
 *  (\r\n → \n), trimmed; nothing left → null. Never longer than the limit
 *  (the schema refuses a longer one before this runs). */
export function cleanChipNote(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim();
  return s ? s.slice(0, CHIP_NOTE_MAX) : null;
}

/** The server's check of a note in a request body: text up to the limit
 *  (after trimming). Missing = not sent (nothing changes); null or empty =
 *  no note. The stored value is cleanChipNote's. */
export const chipNoteSchema = (label: string) =>
  z
    .string({ error: `${label}: יש להזין טקסט` })
    .trim()
    .max(CHIP_NOTE_MAX, `${label} ארוכה מדי — עד ${CHIP_NOTE_MAX} תווים`)
    .nullable()
    .optional();

/** What a user may do with chip orders, as the routes establish it. */
export interface ChipNoteWriter {
  role: Role;
  /** chips:edit */
  canEditChips: boolean;
  /** chips_orders_manage:edit */
  canManageOrders: boolean;
}

/**
 * Who may write which note. The orderer's note is written by the public form
 * only — no signed-in user writes it. The guard note: whoever prepares or
 * issues chips (chips:edit + chips_orders_manage:edit), never a guard. The
 * delivery note: whoever hands over — the pickup screen's roles (guard, admin,
 * super admin), or a staff member who marks the order collected
 * (chips_orders_manage:edit).
 */
export function mayWriteChipNote(kind: ChipNoteKind, who: ChipNoteWriter): boolean {
  if (kind === 'orderer') return false;
  if (kind === 'guard') return who.role !== 'guard' && who.canEditChips && who.canManageOrders;
  return CHIP_PICKUP_ROLES.includes(who.role) || (who.role !== 'guard' && who.canManageOrders);
}
