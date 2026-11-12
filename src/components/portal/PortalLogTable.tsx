'use client';

import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
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
//
// `contained` (the admin screen only) turns the table into ONE scroll box that is
// also the card: it scrolls both ways inside itself, the header row stays put, the
// horizontal scrollbar is always on screen (the box is capped at 70% of the
// viewport) and the long columns (owner, apartments, IP) are cut with an ellipsis
// and carry the full value in `title`. The apartment-card tab leaves it off and
// renders exactly what it always did.

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
// Sticky header cells: they need their own background (the rows scroll under them), and an inset
// line instead of the row's bottom border — a border-collapse border does not travel with a sticky cell.
const HEAD_STICKY = 'sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_var(--color-slate-200)]';
const CELL = 'px-4 py-3 text-sm';

/** A cell's content, cut to `max` with an ellipsis and the whole value in `title` — only when the
 *  table is `contained`; otherwise the content passes through untouched (no extra element). */
function Clip({ on, max, text, children }: { on: boolean; max: string; text: string; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return <span title={text} className={cn('block truncate', max)}>{children}</span>;
}

export function PortalLogTable({ events, showApartment, contained = false }: {
  events: PortalLoginEvent[];
  /** The admin screen shows it; the apartment card does not (one apartment). */
  showApartment: boolean;
  /** The admin screen: one scroll box (both axes), sticky header, clipped long values. */
  contained?: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין התחברויות להצגה.
      </div>
    );
  }

  const head = cn(HEAD, contained && HEAD_STICKY);

  const content = (
    <>
      <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
        <TableRow className="bg-slate-50 hover:bg-slate-50">
          <TableHead className={head}>תאריך ושעה</TableHead>
          {showApartment && <TableHead className={head}>דירה</TableHead>}
          <TableHead className={head}>בעלים</TableHead>
          <TableHead className={head}>טלפון</TableHead>
          <TableHead className={head}>אירוע</TableHead>
          <TableHead className={head}>IP</TableHead>
          <TableHead className={head}>מכשיר</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => {
          const apartments = e.apartment_numbers.length > 0 ? e.apartment_numbers.join(', ') : '—';
          const owner = e.owner_name ?? '—';
          const ip = e.ip ?? '—';
          return (
            <TableRow key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
              <TableCell className={`${CELL} whitespace-nowrap font-num tabular-nums text-slate-700`} dir="ltr">
                {dtFmt.format(new Date(e.created_at))}
              </TableCell>
              {showApartment && (
                <TableCell className={`${CELL} font-bold text-slate-900`}>
                  <Clip on={contained} max="max-w-[10rem]" text={apartments}>{apartments}</Clip>
                </TableCell>
              )}
              <TableCell className={`${CELL} font-medium text-slate-800`}>
                <Clip on={contained} max="max-w-[14rem]" text={owner}>{owner}</Clip>
              </TableCell>
              <TableCell className={`${CELL} whitespace-nowrap font-num tabular-nums text-slate-600`} dir="ltr">
                {formatPhoneDisplay(e164ToLocal(e.phone_e164)) ?? e.phone_e164}
              </TableCell>
              <TableCell className={CELL}><PortalEventBadge eventType={e.event_type} /></TableCell>
              <TableCell className={`${CELL} font-num tabular-nums text-slate-500`} dir="ltr">
                <Clip on={contained} max="max-w-[10rem]" text={ip}>{ip}</Clip>
              </TableCell>
              <TableCell className={`${CELL} text-slate-500`}>{deviceLabel(e.user_agent)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </>
  );

  if (!contained) {
    return (
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <Table className="min-w-[720px]">{content}</Table>
      </div>
    );
  }

  // `Table` wraps its <table> in its own overflow-x-auto div — a second scroll box that would also
  // capture the sticky header. Here the card IS the scroll box, so the bare <table> goes inside it.
  // The box is focusable (a scrollable region must be reachable by keyboard) and named.
  return (
    <div
      role="region"
      aria-label="יומן התחברויות לפורטל"
      tabIndex={0}
      data-log-scroll
      className="max-h-[70dvh] overflow-auto rounded-lg border border-slate-200 bg-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
    >
      <table data-slot="table" className="w-full min-w-[720px] caption-bottom text-sm">{content}</table>
    </div>
  );
}
