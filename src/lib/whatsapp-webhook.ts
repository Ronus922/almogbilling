import 'server-only';
import { appUrl } from '@/lib/config';
import { env } from '@/env';

// The canonical Green API inbound webhook — shared by every instance. Green API
// calls POST {webhookUrl} for each notification and sends the instance's
// webhookUrlToken back as `Authorization: Bearer <token>`; the route
// (lib/whatsapp-webhook-auth) authenticates on that token only and identifies
// the instance via instanceData.idInstance. The URL carries no secret.

/** The token to register as webhookUrlToken. Throws when unset: registering a
 *  webhook without it would make every notification a 401, silently. */
export function greenWebhookToken(): string {
  const t = (env.GREENAPI_WEBHOOK_TOKEN ?? '').trim();
  if (!t) throw new Error('GREENAPI_WEBHOOK_TOKEN אינו מוגדר — אי אפשר לרשום webhook');
  return t;
}

/** The webhook URL to register — clean, no query string. */
export function greenWebhookUrl(): string {
  return `${appUrl()}/api/webhooks/greenapi`;
}
