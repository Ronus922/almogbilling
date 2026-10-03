import 'server-only';
import type { PoolClient } from 'pg';
import { identityNameKey, type PortalRole } from '@/lib/portal/identity';
import type { IdentityRelation, PhoneEntryConflict, PhoneEntryDecision } from '@/lib/types/portal';

// Approving that a phone carrying several names is ONE person (03/10/2026,
// "אישור זהות"), and the warning when a phone is typed onto an apartment card
// ("אזהרה בהזנה"). Every function here runs inside the caller's transaction
// and writes its own audit_log row.
//
// The approval covers the NAMES the phone carries at that moment
// (whitespace-normalised, portal_identity_approvals.names); the portal reads it
// on every request (lib/db/portal/identity.ts). A name added later is not
// covered — the phone is blocked again until someone approves again. A record
// with no name is never approved away: the name is filled in on the card.
//
// The entry warning. A phone that ANOTHER apartment already carries under
// ANOTHER name is either one person with two names (a company and its
// manager, a spelling) or a typing mistake — and the portal cannot tell which.
// So the person typing it is asked, with no default: "אותו אדם?"
//   • yes, by someone with portal_manage → the identity is approved there and
//     then (display name + how the person is connected to each apartment);
//   • yes, by anyone else → saved, and a PENDING request waits on the
//     blocked-phones screen; the phone stays blocked until it is approved;
//   • no → saved, and the phone is flagged as a suspected typing mistake (it
//     is blocked by the different names anyway);
//   • cancel → nothing saved (the client simply does not resend).
// It runs after the card was written and before COMMIT: the apartment's
// registrations are read before the write and after it, so only a phone/name
// pair that this save INTRODUCES is questioned (saving an unrelated field
// never asks again). A question without an answer throws
// PhoneEntryConflictError, the route answers 409 and the transaction rolls
// back: nothing was saved.

export interface PortalRegistration {
  phone_e164: string;
  owner_name: string | null;
  role: PortalRole;
}

export class PhoneEntryConflictError extends Error {
  constructor(public readonly conflicts: PhoneEntryConflict[]) {
    super('phone_conflict');
  }
}

/** A decision that cannot be carried out as given (400, message in Hebrew). */
export class IdentityDecisionError extends Error {}

async function audit(client: PoolClient, actorId: string, action: string, phoneE164: string, metadata: object) {
  await client.query(
    `insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
     values ($1, $2, 'portal_phone', $3, $4::jsonb)`,
    [actorId, action, phoneE164, JSON.stringify(metadata)],
  );
}

/** What the apartment's records say right now, in the portal roles — the
 *  same function the roster is synced from. */
export async function registrationsOf(client: PoolClient, apartment: string): Promise<PortalRegistration[]> {
  const r = await client.query<PortalRegistration>(
    `select phone_e164, owner_name, role from public.portal_roster_desired($1)`,
    [apartment],
  );
  return r.rows;
}

/** Where else the records carry the phone in a portal role, apart from `apartment`. */
async function registrationsElsewhere(
  client: PoolClient,
  phoneE164: string,
  apartment: string,
): Promise<{ apartment_number: string; name: string | null; role: PortalRole }[]> {
  const r = await client.query<{ apartment_number: string; name: string | null; role: PortalRole }>(
    `select c.apartment_number, d.owner_name as name, d.role
       from public.contacts c
       cross join lateral public.portal_roster_desired(c.apartment_number) d
      where c.apartment_number <> $2
        and d.phone_e164 = $1
        and (public.portal_owner_e164(c.owner_phone) = $1
             or public.portal_owner_e164(c.tenant_phone) = $1
             or public.portal_owner_e164(c.operator_phone) = $1
             or exists (select 1 from public.contact_people p
                         where p.contact_id = c.id and public.portal_owner_e164(p.phone) = $1))
      order by (c.apartment_number ~ '^[0-9]+$') desc,
               case when c.apartment_number ~ '^[0-9]+$' then c.apartment_number::numeric end,
               c.apartment_number`,
    [phoneE164, apartment],
  );
  return r.rows;
}

async function approvedNames(client: PoolClient, phoneE164: string): Promise<string[] | null> {
  const r = await client.query<{ names: string[] }>(
    `select names from public.portal_identity_approvals where phone_e164 = $1 and status = 'approved'`,
    [phoneE164],
  );
  return r.rows[0]?.names ?? null;
}

/**
 * Ask — or apply the answers. `before` is registrationsOf() taken before the
 * card was written ([] for a new apartment).
 */
export async function checkPhoneEntry(client: PoolClient, args: {
  apartment: string;
  before: PortalRegistration[];
  decisions: PhoneEntryDecision[] | undefined;
  actor: { id: string; canManagePortal: boolean };
}): Promise<void> {
  const { apartment, before, decisions, actor } = args;
  const after = await registrationsOf(client, apartment);
  const introduced = after.filter((a) => !before.some(
    (b) => b.phone_e164 === a.phone_e164 && identityNameKey(b.owner_name) === identityNameKey(a.owner_name),
  ));

  const conflicts: PhoneEntryConflict[] = [];
  for (const reg of introduced) {
    const others = await registrationsElsewhere(client, reg.phone_e164, apartment);
    const key = identityNameKey(reg.owner_name);
    if (!others.some((o) => identityNameKey(o.name) !== key)) continue;
    // Already one person, by an approval that covers every name involved.
    const covered = await approvedNames(client, reg.phone_e164);
    const keys = [key, ...others.map((o) => identityNameKey(o.name))];
    if (covered && keys.every((k) => k !== '' && covered.includes(k))) continue;
    conflicts.push({
      phone_e164: reg.phone_e164,
      apartment_number: apartment,
      entered_name: reg.owner_name,
      role: reg.role,
      others,
    });
  }
  if (conflicts.length === 0) return;

  const answerOf = (c: PhoneEntryConflict) => decisions?.find((d) => d.phone_e164 === c.phone_e164);
  if (conflicts.some((c) => !answerOf(c))) throw new PhoneEntryConflictError(conflicts);

  for (const c of conflicts) {
    const d = answerOf(c)!;
    const meta = {
      phone_e164: c.phone_e164, apartment_number: c.apartment_number, entered_name: c.entered_name,
      role: c.role, others: c.others, decision: d.decision,
    };

    if (d.decision === 'different') {
      await client.query(
        `insert into public.portal_phone_entry_flags
           (phone_e164, apartment_number, entered_name, other_apartments, flagged_by)
         values ($1, $2, $3, $4, $5)`,
        [c.phone_e164, c.apartment_number, c.entered_name, c.others.map((o) => o.apartment_number), actor.id],
      );
      await audit(client, actor.id, 'portal_phone_entry_flagged', c.phone_e164, meta);
      continue;
    }

    const names = [...new Set([identityNameKey(c.entered_name), ...c.others.map((o) => identityNameKey(o.name))])];
    if (names.includes('')) {
      throw new IdentityDecisionError('לרשומה אין שם — השלם שם לפני אישור "אותו אדם"');
    }

    if (actor.canManagePortal) {
      const apartments = [c.apartment_number, ...c.others.map((o) => o.apartment_number)];
      const display = d.identity?.display_name?.trim() ?? '';
      const relations = d.identity?.apartments ?? [];
      if (!display || !apartments.every((a) => relations.some((r) => r.apartment_number === a))) {
        throw new IdentityDecisionError('אישור זהות דורש שם תצוגה וקשר לכל דירה');
      }
      const approvalId = await approveIdentity(client, {
        phoneE164: c.phone_e164,
        displayName: display,
        names,
        apartments: relations.filter((r) => apartments.includes(r.apartment_number)),
        actorId: actor.id,
        source: 'entry_warning',
      });
      await audit(client, actor.id, 'portal_phone_entry_confirmed', c.phone_e164, { ...meta, approval_id: approvalId, approved: true });
    } else {
      const requestId = await requestIdentity(client, { phoneE164: c.phone_e164, names, actorId: actor.id });
      await audit(client, actor.id, 'portal_phone_entry_confirmed', c.phone_e164, { ...meta, request_id: requestId, approved: false });
    }
  }
}

/**
 * Approve one identity. A pending request for the phone BECOMES the approval
 * (requester kept); an approval already in force is superseded. One row
 * 'approved' per phone (unique index). Open entry flags of the phone are
 * cleared — someone decided it is one person. Returns the approval's id.
 */
export async function approveIdentity(client: PoolClient, args: {
  phoneE164: string;
  displayName: string;
  names: string[];
  apartments: { apartment_number: string; relation: IdentityRelation }[];
  actorId: string;
  source: 'blocked_screen' | 'entry_warning';
}): Promise<string> {
  const display = args.displayName.trim().replace(/\s+/g, ' ');
  if (!display) throw new IdentityDecisionError('חסר שם תצוגה');
  if (args.names.length === 0 || args.names.includes('')) {
    throw new IdentityDecisionError('לרשומה אין שם — השלם שם לפני אישור "אדם אחד"');
  }

  const superseded = await client.query<{ id: string }>(
    `update public.portal_identity_approvals
        set status = 'superseded', ended_at = now(), ended_by = $2
      where phone_e164 = $1 and status = 'approved'
      returning id`,
    [args.phoneE164, args.actorId],
  );
  const fromRequest = await client.query<{ id: string }>(
    `update public.portal_identity_approvals
        set status = 'approved', display_name = $2, names = $3, decided_by = $4, decided_at = now()
      where phone_e164 = $1 and status = 'pending'
      returning id`,
    [args.phoneE164, display, args.names, args.actorId],
  );
  const id = fromRequest.rows[0]?.id ?? (await client.query<{ id: string }>(
    `insert into public.portal_identity_approvals
       (phone_e164, status, display_name, names, request_source, requested_by, decided_by, decided_at)
     values ($1, 'approved', $2, $3, $4, $5, $5, now())
     returning id`,
    [args.phoneE164, display, args.names, args.source, args.actorId],
  )).rows[0].id;

  for (const a of args.apartments) {
    await client.query(
      `insert into public.portal_identity_apartments (approval_id, apartment_number, relation)
       values ($1, $2, $3)`,
      [id, a.apartment_number, a.relation],
    );
  }
  await client.query(
    `update public.portal_phone_entry_flags set cleared_at = now(), cleared_by = $2
      where phone_e164 = $1 and cleared_at is null`,
    [args.phoneE164, args.actorId],
  );
  await audit(client, args.actorId, 'portal_identity_approved', args.phoneE164, {
    approval_id: id, display_name: display, names: args.names, apartments: args.apartments,
    from_request: fromRequest.rows[0]?.id ?? null, superseded: superseded.rows[0]?.id ?? null, source: args.source,
  });
  return id;
}

/** A "same person" from someone without portal_manage: one pending request
 *  per phone, its names widened when asked again. */
async function requestIdentity(client: PoolClient, args: {
  phoneE164: string;
  names: string[];
  actorId: string;
}): Promise<string> {
  const existing = await client.query<{ id: string; names: string[] }>(
    `select id, names from public.portal_identity_approvals where phone_e164 = $1 and status = 'pending'`,
    [args.phoneE164],
  );
  if (existing.rows[0]) {
    const merged = [...new Set([...existing.rows[0].names, ...args.names])];
    await client.query(`update public.portal_identity_approvals set names = $2 where id = $1`, [existing.rows[0].id, merged]);
    await audit(client, args.actorId, 'portal_identity_requested', args.phoneE164, {
      request_id: existing.rows[0].id, names: merged, widened: true,
    });
    return existing.rows[0].id;
  }
  const r = await client.query<{ id: string }>(
    `insert into public.portal_identity_approvals (phone_e164, status, names, request_source, requested_by)
     values ($1, 'pending', $2, 'entry_warning', $3)
     returning id`,
    [args.phoneE164, args.names, args.actorId],
  );
  await audit(client, args.actorId, 'portal_identity_requested', args.phoneE164, {
    request_id: r.rows[0].id, names: args.names,
  });
  return r.rows[0].id;
}

/** End an approval in force ('revoke') or turn down a waiting request
 *  ('reject'). The phone is blocked again at once (when its names differ).
 *  false = no such row in that state. */
export async function endIdentity(client: PoolClient, args: {
  id: string;
  action: 'revoke' | 'reject';
  actorId: string;
}): Promise<boolean> {
  const from = args.action === 'revoke' ? 'approved' : 'pending';
  const to = args.action === 'revoke' ? 'revoked' : 'rejected';
  const r = await client.query<{ phone_e164: string; display_name: string | null; names: string[] }>(
    `update public.portal_identity_approvals
        set status = $3, ended_at = now(), ended_by = $4,
            decided_by = coalesce(decided_by, $4), decided_at = coalesce(decided_at, now())
      where id = $1 and status = $2
      returning phone_e164, display_name, names`,
    [args.id, from, to, args.actorId],
  );
  const row = r.rows[0];
  if (!row) return false;
  await audit(client, args.actorId, args.action === 'revoke' ? 'portal_identity_revoked' : 'portal_identity_rejected', row.phone_e164, {
    approval_id: args.id, display_name: row.display_name, names: row.names,
  });
  return true;
}
