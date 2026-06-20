// Pure XOR model for a WhatsApp conversation's link target. A conversation is
// linked to a debtor (apartment), a supplier (external contractor), or is
// unlinked — NEVER to both at once. The link kind is DERIVED from which id is
// populated rather than stored in a redundant column.
//
// This is the single source of truth for the XOR rule, used by the DB relink
// primitive (setConversationLink). It is pure (no DB / no server-only) so the
// rule is unit-tested directly — mirroring the spirit of the retired
// assertSingleAssignee helper, adapted to the debtor/supplier pair.

import type { ChatLinkStatus } from '@/types/whatsapp';

export type ChatLinkKind = 'debtor' | 'supplier' | 'unlinked';

/**
 * Derive the link kind from the two FK columns. Debtor takes precedence — it is
 * the primary match at insert time (the auto cross-reference tries debtor first,
 * supplier second) — but in practice the two are mutually exclusive because
 * normalizeChatLink() enforces XOR on every write.
 */
export function deriveChatLinkKind(
  debtorId: string | null | undefined,
  supplierId: string | null | undefined,
): ChatLinkKind {
  if (debtorId) return 'debtor';
  if (supplierId) return 'supplier';
  return 'unlinked';
}

/** A normalized, XOR-safe link target ready to write to every row of a chat. */
export interface NormalizedChatLink {
  debtorId: string | null;
  supplierId: string | null;
  linkStatus: ChatLinkStatus;
}

/**
 * Collapse a caller's intent into an XOR-safe target:
 *   - a supplier id present  → link to supplier, clear debtor   (linked)
 *   - a debtor id present    → link to debtor,   clear supplier (linked)
 *   - both empty             → unlinked (both null)
 *
 * Supplier is checked first only as a tie-breaker for a malformed call that
 * passes both; legitimate callers pass exactly one (or neither, to unlink).
 * Empty strings are treated as "absent".
 */
export function normalizeChatLink(target: {
  debtorId?: string | null;
  supplierId?: string | null;
}): NormalizedChatLink {
  const supplierId = target.supplierId ? target.supplierId : null;
  const debtorId = target.debtorId ? target.debtorId : null;

  if (supplierId) return { debtorId: null, supplierId, linkStatus: 'linked' };
  if (debtorId) return { debtorId, supplierId: null, linkStatus: 'linked' };
  return { debtorId: null, supplierId: null, linkStatus: 'unlinked' };
}
