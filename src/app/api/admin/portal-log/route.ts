import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listPortalEvents } from '@/lib/db/portal/events';
import { PORTAL_EVENT_TYPES, type PortalEventType } from '@/lib/constants/portal';
import type { PortalLogFilters } from '@/lib/types/portal';

export const runtime = 'nodejs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/admin/portal-log — the WHOLE login log, including attempts from phones
// that are not on the roster (they carry no apartment, and the screen shows "—").
// `portal_manage:view` (admin / super_admin).
//
// Filters: event type, phone (substring), apartment, date range. An unknown
// event type is dropped rather than 400'd — a stale bookmark should show the
// unfiltered log, not an error.
export async function GET(req: Request) {
  try {
    await requirePermission('portal_manage', 'view');

    const sp = new URL(req.url).searchParams;
    const eventType = sp.get('event_type');
    const from = sp.get('from');
    const to = sp.get('to');
    const limit = Number.parseInt(sp.get('limit') ?? '', 10);

    const filters: PortalLogFilters = {
      apartment: sp.get('apartment')?.trim() || undefined,
      phone: sp.get('phone')?.replace(/[^\d+]/g, '') || undefined,
      eventType: PORTAL_EVENT_TYPES.includes(eventType as PortalEventType)
        ? (eventType as PortalEventType)
        : undefined,
      from: from && ISO_DATE.test(from) ? from : undefined,
      to: to && ISO_DATE.test(to) ? to : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    };

    return NextResponse.json({ events: await listPortalEvents(filters) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
