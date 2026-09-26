import 'server-only';
import { appUrl } from '@/lib/config';
import { env } from '@/env';

// The canonical Green API inbound webhook — shared by every instance. Green API
// calls POST {webhookUrl} for each notification and, when webhookUrlToken is
// set on the instance, sends it back as `Authorization: Bearer <token>`; the
// route (see lib/whatsapp-webhook-auth) authenticates on that token and
// identifies the instance via instanceData.idInstance.
//
// Transition (F8): with GREENAPI_WEBHOOK_TOKEN configured the URL is clean and
// the token is registered as webhookUrlToken. Without it — the legacy state —
// the shared secret still rides in `?secret=` (and lands in access logs). The
// legacy branch goes away once the instance has been switched over.

function webhookSecret(): string {
  return (env.GREEN_API_WEBHOOK_SECRET ?? '').trim();
}

/** Bearer token Green API must send back (registered as webhookUrlToken); '' = not configured. */
export function greenWebhookToken(): string {
  return (env.GREENAPI_WEBHOOK_TOKEN ?? '').trim();
}

/** Webhook URL to register: clean when the token is configured, else the legacy `?secret=` form. */
export function greenWebhookUrl(): string {
  const base = `${appUrl()}/api/webhooks/greenapi`;
  if (greenWebhookToken()) return base;
  const s = webhookSecret();
  return `${base}${s ? `?secret=${s}` : ''}`;
}

/** Hide the (legacy) secret value before returning a URL to the client. */
export function maskWebhookSecret(url: string): string {
  return url.replace(/([?&]secret=)[^&]*/i, '$1•••');
}
