import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getGreenApiSettings,
  GreenApiNotConfiguredError,
} from '@/lib/db/greenApiSettings';
import { getInstanceState, WhatsAppError } from '@/lib/whatsapp';

export const runtime = 'nodejs';

// POST /api/settings/green-api/test — connection probe against the SAVED
// credentials (getStateInstance). Admin only. Returns the instance state.
export async function POST() {
  try {
    await requireAdmin();
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
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  try {
    const { stateInstance } = await getInstanceState({ instanceId, token });
    const authorized = stateInstance === 'authorized';
    return NextResponse.json({ ok: authorized, stateInstance });
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
