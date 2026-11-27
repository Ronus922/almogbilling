import 'server-only';
import type { Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import type { ChipNoteWriter } from './notes';

/** What a signed-in user may do with chip orders — the input of
 *  mayWriteChipNote (notes.ts), from the actor the route established. */
export function noteWriter(actor: Pick<Actor, 'role' | 'permissions'>): ChipNoteWriter {
  return {
    role: actor.role,
    canEditChips: hasPermission(actor.role, actor.permissions, 'chips', 'edit'),
    canManageOrders: hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'edit'),
  };
}
