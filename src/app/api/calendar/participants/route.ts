import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listAssignableUsers } from '@/lib/db/users';
import { listContacts } from '@/lib/db/contacts';
import type { ParticipantSource } from '@/lib/types/calendar';

export const runtime = 'nodejs';

interface ParticipantOption {
  source: ParticipantSource;
  id: string;
  name: string;
  email: string | null;
  hint: string | null; // e.g. apartment number for a contact
}

// GET /api/calendar/participants?search=  (calendar:view)
// Unified picker source: active users + contacts (matched against the search term).
export async function GET(req: NextRequest) {
  try {
    await requirePermission('calendar', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const search = req.nextUrl.searchParams.get('search')?.trim() ?? '';
  const lower = search.toLowerCase();

  try {
    const [users, contacts] = await Promise.all([
      listAssignableUsers(),
      // Only hit contacts when the user is actually searching, to keep the list tight.
      search ? listContacts({ search, sort: 'apartment_asc' }) : Promise.resolve([]),
    ]);

    const userOptions: ParticipantOption[] = users
      .map((u) => ({
        source: 'user' as const,
        id: u.id,
        name: u.full_name ?? u.username,
        email: null,
        hint: null,
      }))
      .filter((o) => !search || o.name.toLowerCase().includes(lower));

    const contactOptions: ParticipantOption[] = [];
    for (const c of contacts.slice(0, 50)) {
      // A contact row holds owner + tenant; surface whichever has a name.
      if (c.owner_name) {
        contactOptions.push({
          source: 'contact',
          id: c.id,
          name: c.owner_name,
          email: c.owner_email,
          hint: `דירה ${c.apartment_number} · בעלים`,
        });
      } else if (c.tenant_name) {
        contactOptions.push({
          source: 'contact',
          id: c.id,
          name: c.tenant_name,
          email: c.tenant_email,
          hint: `דירה ${c.apartment_number} · שוכר`,
        });
      } else {
        contactOptions.push({
          source: 'contact',
          id: c.id,
          name: `דירה ${c.apartment_number}`,
          email: c.owner_email ?? c.tenant_email,
          hint: 'איש קשר',
        });
      }
    }

    return NextResponse.json({
      users: userOptions.slice(0, 50),
      contacts: contactOptions,
    });
  } catch (err) {
    console.error('[GET /api/calendar/participants]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
