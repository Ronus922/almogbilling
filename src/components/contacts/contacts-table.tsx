'use client';

import { Pencil } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatPhoneDisplay, phoneTelHref } from '@/lib/phone';
import { RESIDENT_TYPE_META } from '@/lib/constants/contacts';
import { UNIT_TYPE_LABEL } from '@/lib/constants/chips';
import type { Contact, ContactPersonRole } from '@/lib/types/contacts';

/**
 * How many ADDITIONAL phone numbers the apartment holds for a role (2nd owner,
 * 2nd tenant, …). Only the count is shown — the numbers themselves stay in the
 * apartment card, so the table keeps one line per apartment.
 */
function extraPhoneCount(c: Contact, role: ContactPersonRole): number {
  return (c.people ?? []).filter((p) => p.role === role && p.phone && p.phone.trim() !== '').length;
}

export function ContactsTable({
  rows,
  loading,
  canEdit,
  onRowClick,
}: {
  rows: Contact[];
  loading: boolean;
  canEdit: boolean;
  onRowClick: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-muted/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין דיירים. ייבא קובץ Excel או הוסף ידנית.
      </div>
    );
  }

  return (
    <>
      {/* Desktop table (md+) */}
      <div className="hidden rounded-lg border border-slate-200 bg-white overflow-hidden md:block">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">דירה</TableHead>
              <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">בעלים</TableHead>
              <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">טלפון בעל</TableHead>
              <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500 max-lg:hidden">שוכר</TableHead>
              <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 max-lg:hidden">טלפון שוכר</TableHead>
              <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">סוג</TableHead>
              <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500 w-16">פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow
                key={c.id}
                onClick={() => onRowClick(c.id)}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 h-12"
              >
                <TableCell className="px-4 py-3 text-right text-sm font-bold text-slate-900">
                  <span className="inline-flex items-center gap-1.5">
                    {c.apartment_number}
                    <UnitTypePill type={c.unit_type} />
                    <NeedsReviewPill show={c.needs_review} />
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-right text-sm font-medium text-slate-800">
                  {c.owner_name || <span className="text-slate-400">—</span>}
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm tabular-nums">
                  <span className="inline-flex items-center gap-1.5">
                    <PhoneLink raw={c.owner_phone} />
                    <ExtraPhonesBadge count={extraPhoneCount(c, 'owner')} />
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-right text-sm text-slate-700 max-lg:hidden">
                  {c.tenant_name || <span className="text-slate-400">—</span>}
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center text-sm tabular-nums max-lg:hidden">
                  <span className="inline-flex items-center gap-1.5">
                    <PhoneLink raw={c.tenant_phone} />
                    <ExtraPhonesBadge count={extraPhoneCount(c, 'tenant')} />
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-center">
                  <ResidentTypeBadge type={c.resident_type} />
                </TableCell>
                <TableCell className="px-4 py-3 text-center">
                  <button
                    type="button"
                    aria-label={canEdit ? 'ערוך דייר' : 'פתח כרטיס דייר'}
                    onClick={(e) => { e.stopPropagation(); onRowClick(c.id); }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-600"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards (below md) */}
      <div className="space-y-2 md:hidden">
        {rows.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onRowClick(c.id)}
            className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 text-start transition-colors hover:bg-slate-50 cursor-pointer"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-bold text-blue-700 tabular-nums">
              {c.apartment_number}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold text-slate-900">
                {c.owner_name || 'ללא שם בעלים'}
              </div>
              <div dir="ltr" className="flex items-center gap-1.5 truncate text-start text-sm text-muted-foreground tabular-nums">
                <span className="truncate">
                  {formatPhoneDisplay(c.owner_phone) ?? '—'}
                  {c.tenant_name ? ` · ${c.tenant_name}` : ''}
                </span>
                <ExtraPhonesBadge count={extraPhoneCount(c, 'owner') + extraPhoneCount(c, 'tenant')} />
              </div>
            </div>
            <ResidentTypeBadge type={c.resident_type} />
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * "+N" chip: this apartment holds N more phone numbers than the one shown. The
 * numbers are deliberately NOT rendered here — open the apartment card to see
 * them. Nothing renders when there are no extras.
 */
function ExtraPhonesBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      dir="rtl"
      title={`יש עוד ${count} מספרי טלפון לדירה זו — לצפייה פתח את כרטיס הדירה`}
      className="inline-flex shrink-0 items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 ring-1 ring-blue-100"
    >
      +{count}
    </span>
  );
}

/** Slate pill naming the unit kind — hidden for a plain apartment (the default). */
function UnitTypePill({ type }: { type: Contact['unit_type'] }) {
  if (!type || type === 'apartment') return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
      {UNIT_TYPE_LABEL[type] ?? type}
    </span>
  );
}

/** Amber pill — the row was auto-created by an import and awaits vetting. */
function NeedsReviewPill({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      title="נוצר אוטומטית מייבוא — טרם נבדק"
      className="inline-flex shrink-0 items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200"
    >
      לבדיקה
    </span>
  );
}

function ResidentTypeBadge({ type }: { type: Contact['resident_type'] }) {
  const meta = RESIDENT_TYPE_META[type];
  return (
    <span className={cn('inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold', meta.badge)}>
      {meta.label}
    </span>
  );
}

/** Clickable tel: link from a raw phone, or an em-dash. */
function PhoneLink({ raw }: { raw: string | null }) {
  const display = formatPhoneDisplay(raw);
  const href = phoneTelHref(raw);
  if (!display || !href) return <span className="text-slate-500">—</span>;
  return (
    <a
      href={`tel:${href}`}
      onClick={(e) => e.stopPropagation()}
      className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
    >
      {display}
    </a>
  );
}
