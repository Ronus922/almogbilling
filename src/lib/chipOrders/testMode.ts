import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appUrl } from '@/lib/config';
import { getChipOrderTestModeRow, setChipOrderTestModeRow } from '@/lib/db/appSettings';
import { CHIP_ORDER_TEST_HEADER } from './model';

// Test mode of /chip-order (13/11/2026): Ronen walks the whole order flow —
// phone code, lease upload, server price, rate limits, messages, /chips —
// before Grow is configured, through a secret link. The payment step becomes
// "סיים הזמנת בדיקה", and the order is is_test (never charged, never counted).
//
// The link is /chip-order?test=<token>. The token:
//   - is 32 random bytes (43 base64url characters);
//   - is stored ONLY as its SHA-256 — shown once, when it is made;
//   - is compared in constant time (timingSafeEqual over the two digests);
//   - travels on every API call of the page in the X-Chip-Order-Test header
//     (never in a URL the server logs), and is checked again by every one;
//   - dies when the switch is turned off or a new link is made.
// Without a valid token everything behaves exactly as before — the page
// says "ההזמנות ייפתחו בקרוב" and gives no hint that test mode exists.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/** True only for the CURRENT link's token while the switch is on. */
export async function isValidTestToken(token: string | null | undefined): Promise<boolean> {
  if (!token || !TOKEN_RE.test(token)) return false;
  const row = await getChipOrderTestModeRow();
  if (!row.enabled || !row.tokenHash) return false;
  const want = Buffer.from(row.tokenHash, 'hex');
  const got = digest(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The token a request carries (the page's API calls), or null. */
export function testTokenOf(req: Request): string | null {
  return req.headers.get(CHIP_ORDER_TEST_HEADER)?.trim() || null;
}

/** True when the request carries the current, valid test token. */
export async function isTestRequest(req: Request): Promise<boolean> {
  return isValidTestToken(testTokenOf(req));
}

export function testLink(token: string): string {
  return `${appUrl()}/chip-order?test=${token}`;
}

export interface TestModeState {
  enabled: boolean;
  linkCreatedAt: string | null;
}

export async function getTestModeState(): Promise<TestModeState> {
  const row = await getChipOrderTestModeRow();
  return { enabled: row.enabled, linkCreatedAt: row.enabled ? row.linkCreatedAt : null };
}

/** Switch on, or "צור קישור חדש": a fresh token replaces the previous one
 *  (which stops working at once). Returns the link — the only time the token
 *  exists outside the browser that opens it. */
export async function issueTestLink(actorId: string): Promise<{ link: string; state: TestModeState }> {
  const token = randomBytes(32).toString('base64url');
  const linkCreatedAt = new Date().toISOString();
  await setChipOrderTestModeRow({ enabled: true, tokenHash: digest(token).toString('hex'), linkCreatedAt }, actorId);
  return { link: testLink(token), state: { enabled: true, linkCreatedAt } };
}

/** Switch off: the token is dropped, every open test page stops working. */
export async function disableTestMode(actorId: string): Promise<TestModeState> {
  await setChipOrderTestModeRow({ enabled: false, tokenHash: null, linkCreatedAt: null }, actorId);
  return { enabled: false, linkCreatedAt: null };
}
