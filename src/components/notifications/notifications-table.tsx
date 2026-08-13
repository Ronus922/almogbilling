'use client';

import { Trash2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  getNotificationVisual, formatRelativeTime, formatAbsoluteTime,
  SOURCE_MODULE_LABEL, PRIORITY_LABEL, PRIORITY_PILL,
  type SourceModule, type Priority,
} from '@/lib/notifications/registry';
import type { Notification } from '@/lib/types/tasks';
import { useHasMounted } from '@/lib/hooks/useHasMounted';

function moduleLabel(m: string | null): string {
  if (!m) return '—';
  return SOURCE_MODULE_LABEL[m as SourceModule] ?? m;
}

export function NotificationsTable({
  items,
  onSelect,
  onClear,
}: {
  items: Notification[];
  onSelect: (n: Notification) => void;
  onClear: (n: Notification) => void;
}) {
  // formatRelativeTime is Date.now()-relative → render it only after mount; the
  // SSR/first paint uses the deterministic absolute stamp (avoids React #418).
  const mounted = useHasMounted();
  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין התראות להצגה.
      </div>
    );
  }

  return (
    <>
      {/* מובייל (<md) — כרטיס לכל התראה במקום טבלה בת 7 עמודות. */}
      <ul className="space-y-2 roomy:hidden">
        {items.map((n) => {
          const v = getNotificationVisual(n.type);
          const Icon = v.icon;
          return (
            <li
              key={n.id}
              className={cn(
                'relative rounded-xl border border-slate-200 bg-white p-3 shadow-soft-xs',
                !n.is_read && 'border-blue-200 bg-blue-50/40',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(n)}
                aria-label={`פתיחת התראה: ${n.title}`}
                className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              />
              {/* Transparent to pointer events so a tap on the card body reaches
                  the stretched button beneath; delete opts back in below. */}
              <div className="pointer-events-none relative z-10 flex items-start gap-2.5">
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', v.toneClass)}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    {!n.is_read && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-label="לא נקראה" />}
                    <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-slate-900">{n.title}</span>
                  </div>
                  {n.message && (
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] text-slate-500">{n.message}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[12px] font-medium text-slate-600">
                      {moduleLabel(n.source_module)}
                    </span>
                    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium', PRIORITY_PILL[n.priority as Priority] ?? PRIORITY_PILL.normal)}>
                      {PRIORITY_LABEL[n.priority as Priority] ?? n.priority}
                    </span>
                    <span className="text-[12px] text-slate-500">
                      {mounted ? formatRelativeTime(n.created_at) : formatAbsoluteTime(n.created_at)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="מחק התראה"
                  onClick={(e) => { e.stopPropagation(); onClear(n); }}
                  className="pointer-events-auto relative z-10 inline-grid h-11 w-11 shrink-0 place-items-center rounded-md text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white roomy:block">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 w-16">סטטוס</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">סוג</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">הודעה</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">מקור</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">עדיפות</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">זמן</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 w-16">מחיקה</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((n) => {
            const v = getNotificationVisual(n.type);
            const Icon = v.icon;
            return (
              <TableRow
                key={n.id}
                onClick={() => onSelect(n)}
                className={cn(
                  'h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50',
                  !n.is_read && 'bg-blue-50/40',
                )}
              >
                <TableCell className="px-4 py-3 text-center">
                  <span className="inline-flex">
                    <span className={cn('h-2 w-2 rounded-full', n.is_read ? 'bg-transparent' : 'bg-blue-500')} />
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-start text-sm">
                  <span className="inline-flex items-center gap-2">
                    <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', v.toneClass)}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-slate-700">{v.label}</span>
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-start text-sm">
                  <span className="block max-w-md truncate font-medium text-slate-900">{n.title}</span>
                  {n.message && <span className="block max-w-md truncate text-xs text-slate-500">{n.message}</span>}
                </TableCell>
                <TableCell className="px-4 py-3 text-center text-sm">
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    {moduleLabel(n.source_module)}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-center text-sm">
                  <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', PRIORITY_PILL[n.priority as Priority] ?? PRIORITY_PILL.normal)}>
                    {PRIORITY_LABEL[n.priority as Priority] ?? n.priority}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-center text-sm text-slate-500">
                  {mounted ? formatRelativeTime(n.created_at) : formatAbsoluteTime(n.created_at)}
                </TableCell>
                <TableCell className="px-4 py-3 text-center">
                  <button
                    type="button"
                    aria-label="מחק התראה"
                    title="מחק התראה"
                    onClick={(e) => { e.stopPropagation(); onClear(n); }}
                    className="inline-grid h-9 w-9 place-items-center rounded-md text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-600 focus-visible:text-rose-600 cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </div>
    </>
  );
}
