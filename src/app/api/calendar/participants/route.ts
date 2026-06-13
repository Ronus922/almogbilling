import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listAssignableUsers } from '@/lib/db/users';

export const runtime = 'nodejs';

interface ParticipantOption {
  source: 'user';
  id: string;
  name: string;
}

// GET /api/calendar/participants?search=  (calendar:view)
// Picker source: ACTIVE SYSTEM USERS ONLY. Contacts are intentionally NOT
// included — external attendees (lawyer, contractor, city rep, …) are entered
// as free text in the event panel, not picked here.
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
    const users = await listAssignableUsers();

    const userOptions: ParticipantOption[] = users
      .map((u) => ({
        source: 'user' as const,
        id: u.id,
        name: u.full_name ?? u.username,
      }))
      .filter((o) => !search || o.name.toLowerCase().includes(lower))
      .slice(0, 50);

    return NextResponse.json({ users: userOptions });
  } catch (err) {
    console.error('[GET /api/calendar/participants]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
