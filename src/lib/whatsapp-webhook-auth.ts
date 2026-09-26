import { timingSafeEqual } from 'node:crypto';

// Authentication of the Green API inbound webhook (/api/webhooks/greenapi).
// Pure (no env, no server-only) so the route and the tests share ONE decision.
//
// Two ways in, checked in this order:
//   'header'       — `Authorization: Bearer <GREENAPI_WEBHOOK_TOKEN>`. This is how
//                    Green API sends webhookUrlToken (their default format).
//   'legacy-query' — `?secret=<GREEN_API_WEBHOOK_SECRET>`. TEMPORARY, until the
//                    instance is switched to the token; the query form leaks the
//                    secret into access logs (F8) and is removed in the next step.
// Both comparisons are constant-time; anything else is rejected (null → 401).

export type WebhookAuthMethod = 'header' | 'legacy-query';

/** Constant-time equality; false for an empty or missing side. */
export function secretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The token out of an `Authorization: Bearer …` header; '' when absent/other scheme. */
export function bearerToken(authorization: string | null | undefined): string {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return m ? m[1] : '';
}

export function authenticateWebhook(
  request: { authorization: string | null | undefined; querySecret: string | null | undefined },
  expected: { token: string; legacySecret: string },
): WebhookAuthMethod | null {
  if (secretMatches(bearerToken(request.authorization), expected.token)) return 'header';
  if (secretMatches(request.querySecret ?? '', expected.legacySecret)) return 'legacy-query';
  return null;
}
