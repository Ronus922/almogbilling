import 'server-only';
import { liveCardConfig } from './cardPayment';
import type { ChipOrderSettings } from './model';

// Server-side glue of the public order flow (/chip-order).

/** The page takes orders from the public only when BOTH hold: real card
 *  charging is armed (PAYPLUS_MODE=production + its three values +
 *  PAYPLUS_LIVE_CHARGING=on — see cardPayment.ts) and the /settings switch is
 *  on. Either one missing = "ההזמנות ייפתחו בקרוב" and every write route
 *  refuses. The test link opens the page on its own (testMode.ts). */
export function chipOrdersOpen(settings: ChipOrderSettings): boolean {
  return settings.ordersOpen && liveCardConfig() !== null;
}

/** Public response headers — never cached, never indexed, no Referer leak of a token. */
export const CHIP_ORDER_PUBLIC_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
} as const;
