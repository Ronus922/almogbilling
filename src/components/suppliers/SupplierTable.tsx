'use client';

import { cn } from '@/lib/utils';
import { formatPhoneDisplay, phoneTelHref } from '@/lib/phone';
import type { SupplierListItem } from '@/lib/types/suppliers';
import { SupplierStatusPill, SupplierCategoryBadge } from './SupplierBadges';

// DESIGN.md §28 suppliers table — CSS grid, reference column ratios.
const COLS = 'grid-cols-[1.6fr_1.3fr_1.1fr_1fr_1.3fr_1.6fr_0.9fr]';

export function SupplierTable({
  rows,
  loading,
  onRowClick,
}: {
  rows: SupplierListItem[];
  loading: boolean;
  onRowClick: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-muted/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="p-12 text-center text-sm text-muted-foreground">
        לא נמצאו ספקים. הוסיפו ספק חדש כדי להתחיל.
      </div>
    );
  }

  return (
    <>
      {/* Mobile (<md) — one card per supplier. The desktop grid is seven columns
          held open by `min-w-[880px]`, which on a phone is a 2.7× horizontal
          scrub. Same fields, same row-click, same tel:/mailto: links. */}
      <ul className="space-y-2 p-3 roomy:hidden">
        {rows.map((s) => (
          <li
            key={s.id}
            className="relative rounded-xl border border-[#eef1f6] bg-white p-3 shadow-soft-xs"
          >
            {/* Stretched trigger — keeps the whole card tappable without
                nesting the tel:/mailto: links inside another button. */}
            <button
              type="button"
              onClick={() => onRowClick(s.id)}
              aria-label={`פתיחת ספק ${s.display_name}`}
              className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            />
            <div className="relative z-10 pointer-events-none flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-[14.5px] font-bold text-[#0f172a]">
                {s.display_name}
              </span>
              <SupplierStatusPill status={s.status} />
            </div>
            <div className="relative z-10 pointer-events-none mt-1.5 flex flex-wrap items-center gap-2">
              <SupplierCategoryBadge name={s.category_name} color={s.category_color} />
              {s.contact_person && (
                <span className="truncate text-[13px] font-medium text-[#475569]">
                  {s.contact_person}
                </span>
              )}
            </div>
            {(s.phone || s.mobile || s.email) && (
              <div className="relative z-10 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#f1f4f8] pt-2">
                <PhoneCell raw={s.phone} />
                <PhoneCell raw={s.mobile} />
                {s.email && (
                  <a
                    href={`mailto:${s.email}`}
                    dir="ltr"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex h-11 min-w-0 items-center truncate text-[13.5px] font-medium text-[#2563eb] underline-offset-2 hover:underline"
                  >
                    {s.email}
                  </a>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto roomy:block">
      <div className="min-w-[880px]">
        {/* head */}
        <div className={cn('grid gap-3 border-b border-[#eef1f6] bg-[#fafbfd] px-6 py-[14px]', COLS)}>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-start">שם</span>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-center">קטגוריה</span>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-center">איש קשר</span>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-center">טלפון</span>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-center">נייד</span>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-center">אימייל</span>
          <span className="text-[12.5px] font-bold text-[#94a3b8] text-center">סטטוס</span>
        </div>

        {/* rows */}
        {rows.map((s) => (
          <div
            key={s.id}
            onClick={() => onRowClick(s.id)}
            className={cn(
              'grid cursor-pointer items-center gap-3 border-b border-[#f1f4f8] px-6 py-[18px] transition-colors last:border-0 hover:bg-[#fafbfd]',
              COLS,
            )}
          >
            <span className="truncate text-start text-[14.5px] font-bold text-[#0f172a]">
              {s.display_name}
            </span>
            <span className="flex justify-center">
              <SupplierCategoryBadge name={s.category_name} color={s.category_color} />
            </span>
            <span className="truncate text-center text-[14px] font-medium text-[#475569]">
              {s.contact_person || <em className="not-italic text-[#cbd5e1]">—</em>}
            </span>
            <span className="text-center">
              <PhoneCell raw={s.phone} />
            </span>
            <span className="text-center">
              <PhoneCell raw={s.mobile} />
            </span>
            <span className="text-center">
              {s.email ? (
                <a
                  href={`mailto:${s.email}`}
                  dir="ltr"
                  onClick={(e) => e.stopPropagation()}
                  className="block truncate text-[13.5px] font-medium text-[#2563eb] hover:underline underline-offset-2"
                >
                  {s.email}
                </a>
              ) : (
                <span className="text-[#cbd5e1]">—</span>
              )}
            </span>
            <span className="flex justify-center">
              <SupplierStatusPill status={s.status} />
            </span>
          </div>
        ))}
      </div>
      </div>
    </>
  );
}

/** Centered tel: link (#2563eb, dir=ltr) from a raw phone, or a light em-dash.
 *  In the mobile card the link also carries a 44px tap height; in the desktop
 *  grid cell that height is inert because the row is only 18px of padding tall
 *  around a single line — `inline-flex` keeps it on the text baseline either way. */
function PhoneCell({ raw }: { raw: string }) {
  const display = formatPhoneDisplay(raw);
  const href = phoneTelHref(raw);
  if (!display || !href) return <span className="text-[#cbd5e1]">—</span>;
  return (
    <a
      href={`tel:${href}`}
      dir="ltr"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex h-11 items-center text-[14px] font-semibold tabular-nums text-[#2563eb] underline-offset-2 hover:underline roomy:h-auto"
    >
      {display}
    </a>
  );
}
