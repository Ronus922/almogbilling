import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from '@/env';
import { encrypt, decrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';
import { isGrowConfigured } from '@/lib/grow/client';
import type { ChipOrderSettings } from './model';

// Server-side glue of the public order flow (/chip-order).

/** The page takes orders only when BOTH hold: Grow is configured (its two
 *  identifiers are in the server env) and the settings switch is on. Either
 *  one missing = "ההזמנות ייפתחו בקרוב" and every write route refuses. */
export function chipOrdersOpen(settings: ChipOrderSettings): boolean {
  return settings.ordersOpen && isGrowConfigured();
}

// ── The callback URLs ──────────────────────────────────────────────────────
// Grow's server-to-server callback carries no signature (R/server-to-server-
// callback), so the URL we hand Grow carries our own: an HMAC of the order id
// under SETTINGS_ENC_KEY. A forged call without it is refused before anything
// is read; a call WITH it still proves nothing about payment — the payment is
// confirmed only through Grow's API (getPaymentProcessInfo).

function hmacKey(): Buffer {
  const k = env.SETTINGS_ENC_KEY;
  if (!k) throw new Error('SETTINGS_ENC_KEY is not set (fail-closed)');
  return Buffer.from(k, 'base64');
}

export function callbackSignature(purpose: 'notify' | 'invoice', orderId: string): string {
  return createHmac('sha256', hmacKey()).update(`chip-order:${purpose}:${orderId}`).digest('base64url');
}

export function callbackSignatureValid(purpose: 'notify' | 'invoice', orderId: string, sig: string | null): boolean {
  if (!sig) return false;
  const want = Buffer.from(callbackSignature(purpose, orderId));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── "This phone was verified" ──────────────────────────────────────────────
// After a correct OTP the browser holds an httpOnly cookie with the phone and
// an expiry, sealed with AES-256-GCM (SETTINGS_ENC_KEY) — it cannot be read or
// forged on the client. Submitting an order requires it to name the SAME
// phone the form carries.

export const CHIP_ORDER_PHONE_COOKIE = 'chip_order_phone';
const PHONE_PROOF_TTL_SEC = 30 * 60;

async function setSealedPhoneCookie(name: string, phoneE164: string): Promise<void> {
  const blob = encrypt(JSON.stringify({ p: phoneE164, exp: Date.now() + PHONE_PROOF_TTL_SEC * 1000 }));
  const jar = await cookies();
  jar.set(name, Buffer.from(JSON.stringify(blob)).toString('base64url'), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/public/chip-order',
    maxAge: PHONE_PROOF_TTL_SEC,
  });
}

async function readSealedPhone(name: string): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(name)?.value;
  if (!raw) return null;
  try {
    const blob = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as EncryptedBlob;
    const v = JSON.parse(decrypt(blob)) as { p?: unknown; exp?: unknown };
    if (typeof v.p !== 'string' || typeof v.exp !== 'number' || v.exp < Date.now()) return null;
    return v.p;
  } catch {
    return null;
  }
}

export async function setVerifiedPhoneCookie(phoneE164: string): Promise<void> {
  await setSealedPhoneCookie(CHIP_ORDER_PHONE_COOKIE, phoneE164);
}

/** The verified phone, or null (absent, tampered, expired). */
export async function readVerifiedPhone(): Promise<string | null> {
  return readSealedPhone(CHIP_ORDER_PHONE_COOKIE);
}

// ── "דלג על אימות (מצב בדיקה)" (13/11/2026) ────────────────────────────────
// Test mode only. A SEPARATE sealed cookie, never the verified one:
// readVerifiedPhone() does not read it, so it cannot stand in for a code on a
// real order. The submit honours it only while the SAME request carries the
// valid test token (test mode on), and the order is then stored
// phone_verified = false — which the database allows only on a test order
// (chip_orders_phone_verified_check).

export const CHIP_ORDER_SKIP_COOKIE = 'chip_order_phone_skip';

export async function setSkippedPhoneCookie(phoneE164: string): Promise<void> {
  await setSealedPhoneCookie(CHIP_ORDER_SKIP_COOKIE, phoneE164);
}

/** The phone whose code was skipped in test mode, or null. The caller must
 *  check the test token on the same request. */
export async function readSkippedPhone(): Promise<string | null> {
  return readSealedPhone(CHIP_ORDER_SKIP_COOKIE);
}

export async function clearVerifiedPhoneCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(CHIP_ORDER_PHONE_COOKIE, '', { path: '/api/public/chip-order', maxAge: 0 });
}

/** Public response headers — never cached, never indexed, no Referer leak of a token. */
export const CHIP_ORDER_PUBLIC_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
} as const;
