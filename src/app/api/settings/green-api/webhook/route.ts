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

function webhookUrl(): string {
  return `${appUrl()}/api/whatsapp/webhook`;
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
        expectedUrl,
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
      webhookUrl: currentUrl || null,
      expectedUrl,
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

  return NextResponse.json({ ok: true, webhookUrl: webhookUrl() });
}
