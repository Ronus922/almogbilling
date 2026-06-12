import 'server-only';
import { appUrl } from '@/lib/config';

// The canonical Green API inbound webhook URL — shared by every instance.
// Green API calls POST {webhookUrl} for each notification; the route
// authenticates on the ?secret query param (constant-time compared against
// GREEN_API_WEBHOOK_SECRET) and identifies the instance via instanceData.idInstance.

export function webhookSecret(): string {
  return (process.env.GREEN_API_WEBHOOK_SECRET ?? '').trim();
}

/** Full webhook URL with the shared secret baked in as a query param. */
export function greenWebhookUrl(): string {
  const s = webhookSecret();
  return `${appUrl()}/api/webhooks/greenapi${s ? `?secret=${s}` : ''}`;
}

/** Hide the secret value before returning a URL to the client. */
export function maskWebhookSecret(url: string): string {
  return url.replace(/([?&]secret=)[^&]*/i, '$1•••');
}
