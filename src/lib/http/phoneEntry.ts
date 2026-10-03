import 'server-only';
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import type { Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { phoneEntryDecisionsSchema } from '@/lib/validation/requests';
import {
  checkPhoneEntry, IdentityDecisionError, PhoneEntryConflictError, registrationsOf,
  type PortalRegistration,
} from '@/lib/db/portal/identityApprovals';
import type { PhoneEntryConflict, PhoneEntryDecision } from '@/lib/types/portal';

// The entry warning ("אותו אדם?", 03/10/2026) at the HTTP edge — ONE copy for
// every route that writes a resident phone or the name it is registered
// under: the apartment card (POST and PATCH /api/contacts), the debtor panel
// (PATCH /api/debtors/[id]) and the Bllink queue's approvals
// (POST /api/contacts/suggestions).
//
// A write that puts a phone on an apartment which ANOTHER apartment carries
// under ANOTHER name answers 409 { error: 'phone_conflict', conflicts,
// can_approve } and saves NOTHING (the caller's transaction rolls back); the
// screen asks with PhoneEntryDialog and sends the same write again with the
// answers as `phone_decisions` (lib/db/portal/identityApprovals.ts →
// checkPhoneEntry, which logs each answer with the user).

/** A "yes" from this user approves the identity there and then. */
export function canManagePortal(actor: Actor): boolean {
  return hasPermission(actor.role, actor.permissions, 'portal_manage', 'edit');
}

/** `phone_decisions` of a request body. ok:false → answer 400 invalid_phone_decisions. */
export function readPhoneDecisions(
  rec: Record<string, unknown>,
): { ok: true; decisions: PhoneEntryDecision[] | undefined } | { ok: false } {
  if (rec.phone_decisions === undefined) return { ok: true, decisions: undefined };
  const parsed = phoneEntryDecisionsSchema.safeParse(rec.phone_decisions);
  return parsed.success ? { ok: true, decisions: parsed.data } : { ok: false };
}

/**
 * Run one write inside the caller's transaction, under the entry warning.
 * `apartments` are the apartments as they stand BEFORE the write (none for
 * one the write creates); `write` returns its result and every apartment it
 * wrote to. All their unanswered conflicts are asked together.
 */
export async function withPhoneEntryCheck<T>(
  client: PoolClient,
  args: { apartments: readonly string[]; decisions: PhoneEntryDecision[] | undefined; actor: Actor },
  write: () => Promise<{ result: T; apartments: readonly string[] }>,
): Promise<T> {
  const before = new Map<string, PortalRegistration[]>();
  for (const a of args.apartments) before.set(a, await registrationsOf(client, a));
  const { result, apartments } = await write();
  const unanswered: PhoneEntryConflict[] = [];
  for (const apartment of new Set(apartments)) {
    try {
      await checkPhoneEntry(client, {
        apartment,
        before: before.get(apartment) ?? [],
        decisions: args.decisions,
        actor: { id: args.actor.id, canManagePortal: canManagePortal(args.actor) },
      });
    } catch (err) {
      if (!(err instanceof PhoneEntryConflictError)) throw err;
      unanswered.push(...err.conflicts);
    }
  }
  // Answers already applied for another apartment roll back with the rest.
  if (unanswered.length > 0) throw new PhoneEntryConflictError(unanswered);
  return result;
}

/** The answer to the entry warning's two errors; null for any other error. */
export function phoneEntryErrorResponse(err: unknown, actor: Actor): NextResponse | null {
  if (err instanceof PhoneEntryConflictError) {
    return NextResponse.json({
      error: 'phone_conflict',
      conflicts: err.conflicts,
      can_approve: canManagePortal(actor),
    }, { status: 409 });
  }
  if (err instanceof IdentityDecisionError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return null;
}
