import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { pagePortalEvents } from '@/lib/db/portal/events';
import { PORTAL_EVENT_TYPES, PORTAL_LOG_PAGE_SIZE, type PortalEventType } from '@/lib/constants/portal';
import { parsePage } from '@/lib/pagination';
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
//
// Paged in SQL, PORTAL_LOG_PAGE_SIZE rows to a page: `?page=N` (1-based; anything else
// is page 1). The answer carries `total` — the rows the filters match across the whole
// log, not the page's size — so the screen's counter and its page control are exact.
export async function GET(req: Request) {
  try {
    await requirePermission('portal_manage', 'view');

    const sp = new URL(req.url).searchParams;
    const eventType = sp.get('event_type');
    const from = sp.get('from');
    const to = sp.get('to');
    const page = parsePage(sp.get('page'));

    const filters: PortalLogFilters = {
      apartment: sp.get('apartment')?.trim() || undefined,
      phone: sp.get('phone')?.replace(/[^\d+]/g, '') || undefined,
      eventType: PORTAL_EVENT_TYPES.includes(eventType as PortalEventType)
        ? (eventType as PortalEventType)
        : undefined,
      from: from && ISO_DATE.test(from) ? from : undefined,
      to: to && ISO_DATE.test(to) ? to : undefined,
    };

    const { events, total } = await pagePortalEvents(filters, page, PORTAL_LOG_PAGE_SIZE);
    return NextResponse.json({ events, total, page, page_size: PORTAL_LOG_PAGE_SIZE });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
