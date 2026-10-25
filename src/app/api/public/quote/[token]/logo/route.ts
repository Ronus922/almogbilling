import { NextResponse, type NextRequest } from 'next/server';
import { findPublicContext, getCompany } from '@/lib/db/purchasing';
import { readPurchasingObject } from '@/lib/storage/purchasingStorage';
import { PUBLIC_HEADERS, publicReadGate } from '@/lib/purchasing/publicGate';
import { sniffImage } from '@/lib/purchasing/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PUBLIC (no session) — the company LETTERHEAD logo (purchasing company
// settings), shown on the supplier's page. Gated by a valid token, rate-limited
// like the other public routes. 404 for an unknown token and when there is no logo.
// (Listed in scripts/check-api-auth.mjs PUBLIC, with its token gate.)

interface Ctx { params: Promise<{ token: string }> }

const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404, headers: PUBLIC_HEADERS });

export async function GET(req: NextRequest, ctx: Ctx) {
  const blocked = await publicReadGate(req);
  if (blocked) return blocked;
  const { token } = await ctx.params;
  if (!(await findPublicContext(token))) return notFound();
  const key = (await getCompany())?.logo_key;
  if (!key) return notFound();
  const bytes = await readPurchasingObject(key);
  if (!bytes) return notFound();
  const kind = sniffImage(bytes);
  if (!kind) return notFound();
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS,
      'Content-Type': kind === 'png' ? 'image/png' : 'image/jpeg',
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
