'use client';

import { AlertTriangle, Check, Layers, Package, SquareParking, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { ParkingSummary, ParkingSummaryRow } from '@/lib/types/parking';
import { TableSkeleton } from './shared';

// Tab 3 — the live allocation measured against the 2015 source document.
//
// COLOUR POLICY: emerald is reserved for WhatsApp project-wide, so a matching
// row is NOT green. Agreement reads calm and neutral (slate text, a blue check);
// only disagreement takes colour — amber for a figure that is off, rose for the
// referential check, which is a different class of problem entirely.
//
// This screen is EXPECTED to show ⚠️ on two rows and on the total the moment the
// 2015 data is seeded: the source document's doubles markings were partly lost
// in OCR, so the seed carries 9 doubles against a documented 14. Do not soften
// the presentation to make that go away — surfacing it is the entire job.

function ok(v: boolean) {
  return v
    ? <Check className="h-4 w-4 text-blue-600" aria-hidden />
    : <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />;
}

/**
 * One figure: what the data says, and — only when they disagree — what the
 * document says plus the signed gap. A bare icon would tell the user something
 * is wrong without telling them by how much, which is the number they actually
 * need in order to chase it.
 */
function FigureCell({ actual, expected }: { actual: number; expected: number }) {
  const delta = actual - expected;
  if (delta === 0) {
    return (
      <span dir="ltr" className="text-sm text-slate-700 tabular-nums">{actual}</span>
    );
  }
  return (
    <span dir="ltr" className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-sm font-bold text-amber-700">{actual}</span>
      <span className="text-xs text-slate-400">/ {expected}</span>
      <span className="rounded bg-amber-100 px-1 text-[11px] font-bold text-amber-800">
        {delta > 0 ? `+${delta}` : delta}
      </span>
    </span>
  );
}

function SummaryRowCells({ row, isTotal }: { row: ParkingSummaryRow; isTotal?: boolean }) {
  return (
    <>
      <TableCell className={cn(
        'px-4 py-3 text-start text-sm',
        isTotal ? 'font-extrabold text-slate-900' : 'font-medium text-slate-800',
      )}>
        {row.label}
      </TableCell>
      <TableCell className="px-4 py-3 text-center">
        <FigureCell actual={row.actual.spots} expected={row.expected.spots} />
      </TableCell>
      <TableCell className="px-4 py-3 text-center">
        <FigureCell actual={row.actual.doubles} expected={row.expected.doubles} />
      </TableCell>
      <TableCell className="px-4 py-3 text-center">
        <FigureCell actual={row.actual.places} expected={row.expected.places} />
      </TableCell>
      <TableCell className="px-4 py-3 text-center">
        <span className="inline-flex items-center justify-center" title={row.ok ? 'תואם למסמך' : 'סטייה מהמסמך'}>
          {ok(row.ok)}
          <span className="sr-only">{row.ok ? 'תואם למסמך' : 'סטייה מהמסמך'}</span>
        </span>
      </TableCell>
    </>
  );
}

function Kpi({
  title, value, subtitle, icon: Icon, tone,
}: {
  title: string;
  value: number | string;
  subtitle?: string;
  icon: typeof SquareParking;
  tone: 'blue' | 'violet' | 'slate' | 'amber';
}) {
  const TONE = {
    blue: 'bg-blue-50 text-blue-600',
    violet: 'bg-violet-50 text-violet-600',
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-50 text-amber-600',
  }[tone];
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{title}</div>
          <div dir="ltr" className="mt-2 text-2xl font-extrabold tracking-tight tabular-nums text-start">
            {value}
          </div>
          {subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', TONE)}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
    </Card>
  );
}

export function ParkingSummaryTab({
  summary, loading,
}: {
  summary: ParkingSummary | null;
  loading: boolean;
}) {
  if (loading || !summary) return <TableSkeleton rows={4} />;

  const { rows, total, integrity, kpis } = summary;
  const deviations = rows.filter((r) => !r.ok).length;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi title="חניות" value={kpis.parking_spots} subtitle="שורות פעילות בחניון 1P"
             icon={SquareParking} tone="blue" />
        <Kpi title="מקומות חניה" value={kpis.parking_places}
             subtitle={`כולל ${kpis.parking_doubles} חניות כפולות`} icon={Layers} tone="slate" />
        <Kpi title="מחסנים" value={kpis.storage_units} subtitle="יחידות פעילות"
             icon={Package} tone="violet" />
        <Kpi title="דירות עם הצמדה" value={kpis.apartments_with_parking}
             subtitle={`${kpis.apartments_with_storage} דירות עם מחסן`} icon={Users} tone="slate" />
      </div>

      {/* Headline verdict — stated in words before the table, so the reader is
          not left to infer it from six icons. */}
      <div className={cn(
        'flex items-start gap-3 rounded-lg border p-4',
        summary.ok
          ? 'border-slate-200 bg-slate-50'
          : 'border-amber-200 bg-amber-50',
      )}>
        {summary.ok
          ? <Check className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
          : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
        <div className="min-w-0 text-sm">
          {summary.ok ? (
            <p className="font-semibold text-slate-800">כל השורות תואמות למסמך המקורי מ-14.5.2015.</p>
          ) : (
            <>
              <p className="font-semibold text-amber-900">
                {deviations > 0
                  ? `${deviations} מתוך ${rows.length} שורות אינן תואמות למסמך המקורי מ-14.5.2015.`
                  : 'הנתונים אינם תואמים למסמך המקורי מ-14.5.2015.'}
              </p>
              <p className="mt-1 text-amber-800">
                הפער הידוע: סימוני הכפילות במסמך המקורי (הספרות 1/2/3 בעמודת ההערות) לא שרדו
                את ההמרה, ולכן חסרות 5 חניות כפולות — אחת בקבוצת ״הוצמדו לדירות שנמכרו״ וארבע
                בקבוצת ״נותרו בבעלות חוף הכרמל״. הסטייה מוצגת במכוון ואינה תקלה בתצוגה.
              </p>
            </>
          )}
        </div>
      </div>

      {/* The document's table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">בעלות וסטטוס</TableHead>
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">חניות</TableHead>
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">כפולות</TableHead>
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">מקומות</TableHead>
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">מצב</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.key}
                  className={cn(
                    'h-12 border-b border-slate-100',
                    !r.ok && 'bg-amber-50/60 hover:bg-amber-50',
                    r.ok && 'hover:bg-slate-50',
                  )}
                >
                  <SummaryRowCells row={r} />
                </TableRow>
              ))}
              <TableRow className={cn(
                'h-12 border-t-2 border-slate-300',
                total.ok ? 'bg-slate-50' : 'bg-amber-50',
              )}>
                <SummaryRowCells row={total} isTotal />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        עמודת ״מקומות״ סופרת חניה כפולה כשניים. ערכי ה״צפוי״ מתומללים מהמסמך המקורי
        ואינם מחושבים מהנתונים — לכן סטייה כאן משמעה שהנתונים והמסמך אינם תואמים.
      </p>

      {/* Referential integrity — a different class of problem from a count gap,
          so it gets its own block and a rose (not amber) treatment. */}
      <div className={cn(
        'rounded-lg border p-4',
        integrity.ok ? 'border-slate-200 bg-white' : 'border-rose-200 bg-rose-50',
      )}>
        <div className="flex items-start gap-3">
          {integrity.ok
            ? <Check className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
            : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />}
          <div className="min-w-0 flex-1">
            <p className={cn(
              'text-sm font-semibold',
              integrity.ok ? 'text-slate-800' : 'text-rose-900',
            )}>
              שיוך לדירות קיימות
            </p>
            <p className={cn('mt-1 text-sm', integrity.ok ? 'text-muted-foreground' : 'text-rose-800')}>
              {integrity.ok
                ? 'כל החניות והמחסנים המשויכים לדירה מצביעים על דירה קיימת ברשימת הדיירים.'
                : 'נמצאו רשומות המשויכות למספר דירה שאינו קיים ברשימת הדיירים.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-slate-600">
                חניות ללא דירה קיימת:{' '}
                <span dir="ltr" className={cn(
                  'font-bold tabular-nums',
                  integrity.orphan_parking_spots === 0 ? 'text-slate-900' : 'text-rose-700',
                )}>
                  {integrity.orphan_parking_spots}
                </span>
                <span className="text-slate-400"> / צפוי 0</span>
              </span>
              <span className="text-slate-600">
                מחסנים ללא דירה קיימת:{' '}
                <span dir="ltr" className={cn(
                  'font-bold tabular-nums',
                  integrity.orphan_storage_units === 0 ? 'text-slate-900' : 'text-rose-700',
                )}>
                  {integrity.orphan_storage_units}
                </span>
                <span className="text-slate-400"> / צפוי 0</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
