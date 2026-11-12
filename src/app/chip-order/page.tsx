import { Clock } from 'lucide-react';
import { env } from '@/env';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { listOrderableApartments } from '@/lib/db/chipOrders';
import { chipOrdersOpen } from '@/lib/chipOrders/server';
import { growMode } from '@/lib/grow/client';
import { ChipOrderShell } from '@/components/chip-order/ChipOrderShell';
import { ChipOrderForm } from '@/components/chip-order/ChipOrderForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /chip-order — PUBLIC (no login). Closed — "ההזמנות ייפתחו בקרוב" — until
// Grow is configured AND the settings switch is on (chipOrdersOpen). Open: the
// order form with the apartment NUMBERS of the registry (never a name) and the
// price rule; the price shown is recomputed by the server on submit.
export default async function ChipOrderPage() {
  const settings = await getChipOrderSettings();
  const support = {
    supportPhone: env.NEXT_PUBLIC_PORTAL_SUPPORT_PHONE ?? null,
    supportEmail: env.NEXT_PUBLIC_PORTAL_SUPPORT_EMAIL ?? null,
  };

  if (!chipOrdersOpen(settings)) {
    return (
      <ChipOrderShell {...support}>
        <section
          data-testid="chip-order-closed"
          className="flex flex-col items-center gap-3 rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-8 text-center"
        >
          <span className="grid h-14 w-14 place-items-center rounded-full bg-[var(--chip-brand-soft)] text-[var(--chip-brand)]">
            <Clock className="h-7 w-7" />
          </span>
          <h2 className="text-[20px] font-extrabold">ההזמנות ייפתחו בקרוב</h2>
          <p className="max-w-[420px] text-[14.5px] font-medium text-[var(--chip-ink-muted)]">
            הזמנת צ׳יפים למעלית באתר עדיין לא פתוחה. בינתיים אפשר לפנות לחברת הניהול.
          </p>
        </section>
      </ChipOrderShell>
    );
  }

  const apartments = await listOrderableApartments();
  return (
    <ChipOrderShell {...support}>
      {growMode() === 'sandbox' && (
        <p role="status" className="rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-center text-[13.5px] font-bold text-[var(--chip-amber-ink)]">
          סביבת בדיקות — התשלום בכרטיס בדיקה, אין חיוב אמיתי.
        </p>
      )}
      <ChipOrderForm
        apartments={apartments}
        pricing={{
          unitPrice: settings.unitPrice,
          threshold: settings.threshold,
          priceAbove: settings.priceAbove,
          maxPerApartment: settings.maxPerApartment,
        }}
        termsText={settings.termsText}
      />
    </ChipOrderShell>
  );
}
