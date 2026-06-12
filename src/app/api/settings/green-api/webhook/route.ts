import { NextResponse } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { appUrl } from '@/lib/config';
import {
  getGreenApiSettings,
  ensureGreenApiWebhookToken,
  GreenApiNotConfiguredError,
} from '@/lib/db/greenApiSettings';
import { getWebhookSettings, setWebhookSettings, WhatsAppError } from '@/lib/whatsapp';
import type { GreenApiWebhookStatus } from '@/types/whatsapp';

export const runtime = 'nodejs';

function webhookSecret(): string {
  return (process.env.GREEN_API_WEBHOOK_SECRET ?? '').trim();
}

/** Canonical webhook URL — carries the shared secret as a query param. */
function webhookUrl(): string {
  const s = webhookSecret();
  return `${appUrl()}/api/webhooks/greenapi${s ? `?secret=${s}` : ''}`;
}

/** Hide the secret value before sending a URL to the admin client. */
function maskSecret(url: string): string {
  return url.replace(/([?&]secret=)[^&]*/i, '$1•••');
}

// GET — current inbound-webhook registration status (admin only).
export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const expectedUrl = webhookUrl();

  let instanceId: string;
  let token: string;
  try {
    ({ instanceId, token } = await getGreenApiSettings());
  } catch (err) {
    if (err instanceof GreenApiNotConfiguredError) {
      const status: GreenApiWebhookStatus = {
        registered: false,
        incomingEnabled: false,
        webhookUrl: null,
        expectedUrl: maskSecret(expectedUrl),
      };
      return NextResponse.json(status);
    }
    throw err;
  }

  try {
    const settings = await getWebhookSettings({ instanceId, token });
    const currentUrl = typeof settings.webhookUrl === 'string' ? settings.webhookUrl : '';
    const incomingEnabled = settings.incomingWebhook === 'yes';
    const status: GreenApiWebhookStatus = {
      registered: currentUrl === expectedUrl && incomingEnabled,
      incomingEnabled,
      webhookUrl: currentUrl ? maskSecret(currentUrl) : null,
      expectedUrl: maskSecret(expectedUrl),
    };
    return NextResponse.json(status);
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}

// POST — register/enable inbound receiving: generate a webhook token (if needed)
// and push webhookUrl + token + incomingWebhook=yes to the Green API instance.
export async function POST() {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  if (!webhookSecret()) {
    return NextResponse.json(
      { error: 'GREEN_API_WEBHOOK_SECRET לא מוגדר בשרת. הוסף אותו ל-billing.env ואתחל את השירות.' },
      { status: 500 },
    );
  }

  let instanceId: string;
  let token: string;
  try {
    ({ instanceId, token } = await getGreenApiSettings());
  } catch (err) {
    if (err instanceof GreenApiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // Optional bearer token (defence-in-depth; the canonical webhook authenticates
  // on the ?secret query param baked into the URL).
  let webhookToken: string;
  try {
    webhookToken = await ensureGreenApiWebhookToken(actor.id);
  } catch (err) {
    if (err instanceof GreenApiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  try {
    await setWebhookSettings({ instanceId, token, webhookUrl: webhookUrl(), webhookToken });
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  return NextResponse.json({ ok: true, webhookUrl: maskSecret(webhookUrl()) });
}
