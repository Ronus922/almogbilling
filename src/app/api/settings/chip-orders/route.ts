import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderSettingsBodySchema } from '@/lib/validation/requests';
import { getChipOrderSettings, updateChipOrderSettings } from '@/lib/db/appSettings';
import { growMode } from '@/lib/grow/client';

export const runtime = 'nodejs';

// GET /api/settings/chip-orders — settings:view. The price rule, the texts,
// the page switch, and whether Grow is configured (a yes/no only — never a
// value of the identifiers).
export async function GET() {
  try {
    await requirePermission('settings', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return NextResponse.json({ settings: await getChipOrderSettings(), growMode: growMode() });
}

// PUT /api/settings/chip-orders — settings:edit.
export async function PUT(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('settings', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const body = await parseJsonBody(req, chipOrderSettingsBodySchema);
  if (!body.ok) return body.response;
  const saved = await updateChipOrderSettings(body.data, actor.id);
  return NextResponse.json({ settings: saved, growMode: growMode() });
}
