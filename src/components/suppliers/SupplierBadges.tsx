import { cn } from '@/lib/utils';
import { supplierStatusMeta, type DesignTone } from '@/lib/constants/suppliers';
import type { SupplierStatus } from '@/lib/types/suppliers';

// DESIGN.md §28 status pill — exact reference hexes (table.html row status).
// emerald active = bg #dcfce7 / text #15803d / dot #22c55e (= green-100/700/500 tokens).
const STATUS_TONE: Record<DesignTone, string> = {
  emerald: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-700',
  slate: 'bg-slate-100 text-slate-600',
};

const STATUS_DOT: Partial<Record<DesignTone, string>> = {
  emerald: 'bg-green-500',
};

/**
 * Supplier status pill — DRY across SupplierTable and the detail-panel header.
 * The live "active" state gets a leading status dot (DESIGN.md §28).
 * Reference: padding 4/11, gap 5, 12px/600.
 */
export function SupplierStatusPill({
  status,
  className,
}: {
  status: SupplierStatus;
  className?: string;
}) {
  const meta = supplierStatusMeta(status);
  const dot = STATUS_DOT[meta.tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-full px-[11px] py-[4px] text-xs font-semibold',
        STATUS_TONE[meta.tone],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />}
      {meta.label}
    </span>
  );
}

/**
 * Category-badge tone palette (DESIGN.md §28) — color-per-category. The category
 * data model has no `color` column yet, so the tone is derived deterministically
 * from the category name (stable across renders). Hexes match the reference
 * mockups' badge tones. A future additive `supplier_categories.color` column
 * could replace this with a user-chosen color.
 */
const CATEGORY_TONES = [
  'bg-[#e8f0ff] text-[#2563eb]', // blue  (table row 1)
  'bg-[#e7f7ee] text-[#16a34a]', // green (table row 2)
  'bg-[#fff3e6] text-[#ea8a18]', // amber
  'bg-[#eef2ff] text-[#4f46e5]', // indigo
  'bg-[#fae8ff] text-[#a21caf]', // fuchsia
  'bg-[#ffe4e6] text-[#e11d48]', // rose
  'bg-[#ccfbf1] text-[#0d9488]', // teal
];

function categoryTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_TONES[h % CATEGORY_TONES.length];
}

/**
 * Supplier category badge — DESIGN.md §28 category badge.
 * Color resolution: an explicit `color` hex (migration 052) wins — rendered as a
 * light tint bg (hex + ~13% alpha) with the saturated hex as text. When no color
 * is stored, falls back to the deterministic name-hash tone (CATEGORY_TONES).
 * Em-dash when there is no category. Reference: rounded-full, padding 4/11, 12px/600.
 */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

export function SupplierCategoryBadge({
  name,
  color,
}: {
  name: string | null;
  color?: string | null;
}) {
  if (!name) return <span className="text-[#cbd5e1]">—</span>;
  if (color && HEX6_RE.test(color)) {
    return (
      <span
        className="inline-flex items-center rounded-full px-[11px] py-[4px] text-xs font-semibold"
        style={{ backgroundColor: `${color}22`, color }}
      >
        {name}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[11px] py-[4px] text-xs font-semibold',
        categoryTone(name),
      )}
    >
      {name}
    </span>
  );
}
