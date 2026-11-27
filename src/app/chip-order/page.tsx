import { Clock } from 'lucide-react';
import { env } from '@/env';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { listOrderableApartments } from '@/lib/db/chipOrders';
import { chipOrdersOpen } from '@/lib/chipOrders/server';
import { isValidTestToken } from '@/lib/chipOrders/testMode';
import { CHIP_ORDER_TEST_BANNER } from '@/lib/chipOrders/model';
import { CHIP_ORDER_TEST_CARD_BANNER } from '@/lib/chipOrders/card';
import { liveCardConfig, testCardConfig } from '@/lib/chipOrders/cardPayment';
import { receiptsAreEmailed } from '@/lib/chipOrders/documents';
import { ChipOrderShell } from '@/components/chip-order/ChipOrderShell';
import { ChipOrderForm } from '@/components/chip-order/ChipOrderForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /chip-order — PUBLIC (no login). Closed — "ההזמנות ייפתחו בקרוב" — until
// real card charging is armed AND the settings switch is on (chipOrdersOpen,
// src/lib/chipOrders/server.ts). Open: ONE form (26/11/2026) — the people and
// apartments, the contact block, the payment section (PayPlus hosted fields,
// and the Google Pay / Apple Pay buttons where the device offers them), the
// agreement boxes and one pay button. The apartment NUMBERS of the registry
// only (never a name); one price per chip from the settings, recomputed by the
// server on every save.
//
// Test mode (13/11/2026): /chip-order?test=<token> with the CURRENT token of
// the test link (src/lib/chipOrders/testMode.ts) opens the form even with the
// switch off, under a pinned test strip, and pays with the PayPlus SANDBOX
// (never a real charge). Without the sandbox values (CI) the payment step is
// "סיים הזמנת בדיקה". A missing or wrong token is exactly the closed page —
// no hint that test mode exists.
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
  // The test link pays with the sandbox; a real order with production (armed).
  const cardPayment = testToken ? testCardConfig() !== null : liveCardConfig() !== null;
  return (
    <ChipOrderShell
      {...support}
      banner={testToken ? (cardPayment ? CHIP_ORDER_TEST_CARD_BANNER : CHIP_ORDER_TEST_BANNER) : undefined}
    >
      <ChipOrderForm
        apartments={apartments}
        pricing={{ unitPrice: settings.unitPrice }}
        termsText={settings.termsText}
        testToken={testToken}
        cardPayment={cardPayment}
        // Only where true: a REAL order (a test payment never gets a Morning
        // document) and the Morning key in place — Morning emails the document.
        receiptByEmail={!testToken && cardPayment && receiptsAreEmailed()}
      />
    </ChipOrderShell>
  );
}
