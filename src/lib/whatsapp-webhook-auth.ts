import { timingSafeEqual } from 'node:crypto';

// Authentication of the Green API inbound webhook (/api/webhooks/greenapi).
// Pure (no env, no server-only) so the route and the tests share ONE decision.
//
// Exactly one way in: `Authorization: Bearer <GREENAPI_WEBHOOK_TOKEN>` — the
// instance's webhookUrlToken, which Green API sends back on every notification
// (their default format). Compared constant-time; anything else → null → 401.
// A query-string secret is NOT accepted (it used to be — it leaked into access
// logs, finding F8 — and was retired on 26/09/2026).

export type WebhookAuthMethod = 'header';

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
  request: { authorization: string | null | undefined },
  expected: { token: string },
): WebhookAuthMethod | null {
  return secretMatches(bearerToken(request.authorization), expected.token) ? 'header' : null;
}
