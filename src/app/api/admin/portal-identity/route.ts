import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { portalIdentityActionSchema } from '@/lib/validation/requests';
import { withTransaction } from '@/lib/db';
import { identityNameKey, type PortalRole } from '@/lib/portal/identity';
import { approveIdentity, endIdentity, IdentityDecisionError } from '@/lib/db/portal/identityApprovals';
import { LINK_NAME_SQL } from '@/lib/db/portal/identity';

export const runtime = 'nodejs';

// POST /api/admin/portal-identity — the "טלפונים חסומים" screen's decisions,
// `portal_manage:edit` (admin / super_admin):
//   • approve — "אדם אחד": the phone's CURRENT active links are one person,
//     greeted by display_name; a relation for EVERY apartment of the phone.
//     The names covered are read here, from the links, never from the body —
//     so an approval cannot cover a name the screen did not show. A link with
//     no name refuses (400): the name is completed on the apartment card.
//   • revoke — end an approval in force: the phone is blocked again at once.
//   • reject — turn a waiting request (from the apartment card) down.
// Every decision is an audit_log row (lib/db/portal/identityApprovals.ts).
export async function POST(req: Request) {
  let actorId: string;
  try {
    actorId = (await requirePermission('portal_manage', 'edit')).id;
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const body = await parseJsonBody(req, portalIdentityActionSchema);
  if (!body.ok) return body.response;
  const b = body.data;

  try {
    if (b.action === 'approve') {
      const id = await withTransaction(async (client) => {
        const links = await client.query<{ apartment_number: string; owner_name: string | null; role: PortalRole }>(
          `select r.apartment_number, ${LINK_NAME_SQL('r')} as owner_name, r.role
             from public.apartment_owner_phones r
            where r.phone_e164 = $1 and r.is_active
            for update of r`,
          [b.phone_e164],
        );
        if (links.rows.length < 2) throw new IdentityDecisionError('הטלפון אינו משויך לכמה דירות');
        const apartments = links.rows.map((l) => l.apartment_number);
        if (!apartments.every((a) => b.apartments.some((x) => x.apartment_number === a))
            || b.apartments.some((x) => !apartments.includes(x.apartment_number))) {
          throw new IdentityDecisionError('יש לבחור קשר לכל דירה של הטלפון');
        }
        return approveIdentity(client, {
          phoneE164: b.phone_e164,
          displayName: b.display_name,
          names: [...new Set(links.rows.map((l) => identityNameKey(l.owner_name)))],
          apartments: b.apartments,
          actorId,
          source: 'blocked_screen',
        });
      });
      return NextResponse.json({ ok: true, id });
    }
    const done = await withTransaction((client) => endIdentity(client, { id: b.id, action: b.action, actorId }));
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof IdentityDecisionError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
