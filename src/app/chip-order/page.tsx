import { Clock } from 'lucide-react';
import { env } from '@/env';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { listOrderableApartments } from '@/lib/db/chipOrders';
import { chipOrdersOpen } from '@/lib/chipOrders/server';
import { isValidTestToken } from '@/lib/chipOrders/testMode';
import { CHIP_ORDER_TEST_BANNER } from '@/lib/chipOrders/model';
import { growMode } from '@/lib/grow/client';
import { ChipOrderShell } from '@/components/chip-order/ChipOrderShell';
import { ChipOrderForm } from '@/components/chip-order/ChipOrderForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /chip-order — PUBLIC (no login). Closed — "ההזמנות ייפתחו בקרוב" — until
// Grow is configured AND the settings switch is on (chipOrdersOpen). Open: the
// order form (20/11/2026 design) with the apartment NUMBERS of the registry
// (never a name) and the one price per chip from the settings (21/11/2026 —
// no threshold, no quantity limit); the price shown is recomputed by the
// server on submit.
//
// Test mode (13/11/2026): /chip-order?test=<token> with the CURRENT token of
// the test link (src/lib/chipOrders/testMode.ts) opens the form even without
// Grow and with the switch off, under a pinned "מצב בדיקה, אין חיוב" strip,
// and its payment step is "סיים הזמנת בדיקה". A missing or wrong token is
// exactly the page above — no hint that test mode exists.
export default async function ChipOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ test?: string | string[] }>;
}) {
  const sp = await searchParams;
  const testToken = typeof sp.test === 'string' && (await isValidTestToken(sp.test)) ? sp.test : null;
  const settings = await getChipOrderSettings();
  const support = {
    supportPhone: env.NEXT_PUBLIC_PORTAL_SUPPORT_PHONE ?? null,
    supportEmail: env.NEXT_PUBLIC_PORTAL_SUPPORT_EMAIL ?? null,
  };

  if (!chipOrdersOpen(settings) && !testToken) {
    return (
      <ChipOrderShell {...support}>
        <section data-testid="chip-order-closed" className="cr-cfcard">
          <span className="cr-cfic cr-brand">
            <Clock className="h-7 w-7" />
          </span>
          <h2>ההזמנות ייפתחו בקרוב</h2>
          <p className="cr-msg">
            הזמנת צ׳יפים למעלית באתר עדיין לא פתוחה. בינתיים אפשר לפנות לחברת הניהול.
          </p>
        </section>
      </ChipOrderShell>
    );
  }

  const apartments = await listOrderableApartments();
  return (
    <ChipOrderShell
      {...support}
      banner={testToken ? CHIP_ORDER_TEST_BANNER : undefined}
      notice={!testToken && growMode() === 'sandbox' ? 'סביבת בדיקות — התשלום בכרטיס בדיקה, אין חיוב אמיתי.' : undefined}
    >
      <ChipOrderForm
        apartments={apartments}
        pricing={{ unitPrice: settings.unitPrice }}
        termsText={settings.termsText}
        testToken={testToken}
      />
    </ChipOrderShell>
  );
}
