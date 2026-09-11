import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison for machine-job shared secrets (x-cron-secret).
 * Length is checked first — timingSafeEqual throws on unequal buffers — so a
 * caller learns nothing beyond "no match".
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
