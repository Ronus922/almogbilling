import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { afterChipOrderPaid, confirmChipOrderPayment } from '@/lib/chipOrders/payment';
import { CalendarClock, CheckCircle2, MapPin, XCircle } from 'lucide-react';
import { env } from '@/env';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { getChipOrderTrackView } from '@/lib/db/chipOrders';
import { formatDueText } from '@/lib/chipOrders/notify';
import { CHIP_ORDER_REFUND_LABEL, type ChipOrderStatus } from '@/lib/chipOrders/model';
import { ChipOrderShell } from '@/components/chip-order/ChipOrderShell';
import { ChipOrderStatusPill } from '@/components/chips/ChipOrderStatusPill';
import { TrackAutoRefresh } from '@/components/chip-order/TrackAutoRefresh';
import { cn } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /chip-order/track/<token> — PUBLIC, reached by the link in every message.
// The token is 32 random bytes; the page shows the status, the due date and
// the pickup details ONLY — no name, phone, apartment or amount.

const STEPS: { status: ChipOrderStatus; label: string }[] = [
  { status: 'paid', label: 'שולם' },
  { status: 'approved', label: 'אושר' },
  { status: 'ready', label: 'מוכן לאיסוף' },
  { status: 'collected', label: 'נאסף' },
];
const RANK: Record<ChipOrderStatus, number> = { pending_payment: -1, paid: 0, approved: 1, ready: 2, collected: 3, rejected: -1 };

export default async function ChipOrderTrackPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ paid?: string; cancelled?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  let view = await getChipOrderTrackView(token);
  if (!view) notFound();
  // Right after the payment iframe reported success, Grow's server callback may
  // be late (or blocked): ask Grow directly — the same check the callback runs —
  // at most once per 15 seconds per order while the page refreshes itself.
  if (view.status === 'pending_payment' && sp.paid === '1') {
    const slot = await checkRateLimit(`chip-order:reconcile:${view.id}`, { max: 1, windowSec: 15 });
    if (slot.allowed) {
      const check = await confirmChipOrderPayment(view.id, 'track_page');
      if (check.kind === 'paid') {
        const orderId = view.id;
        if (check.transitioned) after(() => afterChipOrderPaid(orderId, 'track_page'));
        view = (await getChipOrderTrackView(token)) ?? view;
      }
    }
  }
  const settings = view.status === 'ready' ? await getChipOrderSettings() : null;
  const support = {
    supportPhone: env.NEXT_PUBLIC_PORTAL_SUPPORT_PHONE ?? null,
    supportEmail: env.NEXT_PUBLIC_PORTAL_SUPPORT_EMAIL ?? null,
  };
  const rank = RANK[view.status];

  return (
    <ChipOrderShell subtitle={`מעקב הזמנה ${view.order_number}`} {...support}>
      <TrackAutoRefresh waitingForPayment={view.status === 'pending_payment' && sp.paid === '1'} />
      <section data-testid="chip-order-track" className="flex flex-col gap-5 rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[19px] font-extrabold">הזמנה {view.order_number}</h2>
          <ChipOrderStatusPill status={view.status} />
        </div>

        {view.status === 'pending_payment' && (
          <p className="rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-4 text-[14px] font-semibold text-[var(--chip-amber-ink)]">
            {sp.cancelled === '1'
              ? 'התשלום בוטל. ההזמנה לא נקלטה — אפשר להזמין מחדש.'
              : sp.paid === '1'
                ? 'התשלום מתקבל — הדף יתעדכן מעצמו בעוד רגע.'
                : 'ההזמנה עדיין לא שולמה.'}
          </p>
        )}

        {rank >= 0 && (
          <ol className="grid grid-cols-4 gap-2" aria-label="שלבי ההזמנה">
            {STEPS.map((s, i) => (
              <li key={s.status} className="flex flex-col items-center gap-1.5 text-center">
                <span className={cn(
                  'grid h-9 w-9 place-items-center rounded-full border-2 text-[13px] font-bold',
                  i <= rank ? 'border-[var(--chip-green)] bg-[var(--chip-green)] text-white' : 'border-[var(--chip-border-strong)] text-[var(--chip-ink-soft)]',
                )}>
                  {i <= rank ? <CheckCircle2 className="h-5 w-5" /> : i + 1}
                </span>
                <span className={cn('text-[12.5px] font-bold', i <= rank ? 'text-[var(--chip-ink)]' : 'text-[var(--chip-ink-soft)]')}>{s.label}</span>
              </li>
            ))}
          </ol>
        )}

        {view.status === 'approved' && view.due_at && (
          <p className="flex items-start gap-2 text-[14.5px] font-semibold">
            <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-[var(--chip-brand)]" />
            מועד היעד להכנה: {formatDueText(view.due_at)}
          </p>
        )}

        {view.status === 'ready' && (
          <p className="flex items-start gap-2 text-[14.5px] font-semibold">
            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-[var(--chip-green)]" />
            {settings?.pickupText.trim() ? `מקום ושעות האיסוף: ${settings.pickupText.trim()}` : 'הצ׳יפים מוכנים לאיסוף במשרד חברת הניהול.'}
          </p>
        )}

        {view.status === 'rejected' && (
          <div className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] p-4 text-[14px] font-semibold text-[var(--chip-red-ink)]">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p>ההזמנה נדחתה{view.reject_reason ? `: ${view.reject_reason}` : '.'}</p>
              {view.refund_status && <p className="mt-1">מצב הזיכוי: {CHIP_ORDER_REFUND_LABEL[view.refund_status]}</p>}
            </div>
          </div>
        )}
      </section>
    </ChipOrderShell>
  );
}
