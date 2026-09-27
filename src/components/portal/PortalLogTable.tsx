'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { e164ToLocal } from '@/lib/portal/phone';
import { formatPhoneDisplay } from '@/lib/phone';
import type { PortalLoginEvent } from '@/lib/types/portal';
import { PortalEventBadge } from './PortalEventBadge';

// The login-log table — ONE component for both surfaces (the apartment card's
// "התחברויות לפורטל" tab and the full /admin/portal-log screen). The only
// difference is the apartment column, which the card hides because every row on
// it is the same apartment.
//
// Columns per spec: תאריך ושעה · בעלים · אירוע · IP · מכשיר (+ דירה on the admin
// screen). An attempt from a phone that is not on the roster shows "—" in both
// the owner and the apartment cell — that is the whole point of logging it.
// DESIGN.md §9: header h-11 / bg-slate-50, cells px-4 py-3.

/** A user-agent is unreadable in a table cell — show the device family only.
 *  Order matters: Edge and Chrome both claim "Chrome", iPad claims "Macintosh". */
function deviceLabel(ua: string | null): string {
  if (!ua) return '—';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'אחר';
}

const dtFmt = new Intl.DateTimeFormat('he-IL', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
  timeZone: 'Asia/Jerusalem',
});

const HEAD = 'h-11 px-4 text-start text-sm font-semibold text-slate-500';
const CELL = 'px-4 py-3 text-sm';

export function PortalLogTable({ events, showApartment }: {
  events: PortalLoginEvent[];
  /** The admin screen shows it; the apartment card does not (one apartment). */
  showApartment: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין התחברויות להצגה.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <Table className="min-w-[720px]">
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className={HEAD}>תאריך ושעה</TableHead>
            {showApartment && <TableHead className={HEAD}>דירה</TableHead>}
            <TableHead className={HEAD}>בעלים</TableHead>
            <TableHead className={HEAD}>טלפון</TableHead>
            <TableHead className={HEAD}>אירוע</TableHead>
            <TableHead className={HEAD}>IP</TableHead>
            <TableHead className={HEAD}>מכשיר</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => (
            <TableRow key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
              <TableCell className={`${CELL} whitespace-nowrap font-num tabular-nums text-slate-700`} dir="ltr">
                {dtFmt.format(new Date(e.created_at))}
              </TableCell>
              {showApartment && (
                <TableCell className={`${CELL} font-bold text-slate-900`}>
                  {e.apartment_numbers.length > 0 ? e.apartment_numbers.join(', ') : '—'}
                </TableCell>
              )}
              <TableCell className={`${CELL} font-medium text-slate-800`}>{e.owner_name ?? '—'}</TableCell>
              <TableCell className={`${CELL} whitespace-nowrap font-num tabular-nums text-slate-600`} dir="ltr">
                {formatPhoneDisplay(e164ToLocal(e.phone_e164)) ?? e.phone_e164}
              </TableCell>
              <TableCell className={CELL}><PortalEventBadge eventType={e.event_type} /></TableCell>
              <TableCell className={`${CELL} font-num tabular-nums text-slate-500`} dir="ltr">{e.ip ?? '—'}</TableCell>
              <TableCell className={`${CELL} text-slate-500`}>{deviceLabel(e.user_agent)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
