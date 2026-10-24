import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';

/** A slim banner: requests for quotation holding portal quotes nobody opened.
 *  Rendered by the page only when the count is above zero and the viewer holds
 *  the purchasing permission. */
export function PurchasingQuotesCard({ count }: { count: number }) {
  return (
    <Link
      href="/purchasing?tab=rfq"
      data-purchasing-card
      className="flex min-h-[44px] items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 shadow-soft-xs transition-colors hover:bg-row-hover"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-blue-50 text-blue-600">
        <ShoppingCart className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-sm font-bold text-ink">
        {count === 1 ? 'בקשה אחת עם הצעות מחיר חדשות' : `${count} בקשות עם הצעות מחיר חדשות`}
      </span>
      <span className="shrink-0 text-xs font-bold text-brand">לרכש</span>
    </Link>
  );
}
