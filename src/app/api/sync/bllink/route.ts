import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!session.user.is_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = process.env.CRM_SYNC_URL;
  const secret = process.env.CRM_CRON_SECRET;
  if (!url || !secret) {
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'x-cron-secret': secret,
        'content-type': 'application/json',
      },
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  const raw = await upstream.text();
  let data: unknown = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // keep as text
  }

  return NextResponse.json(
    { ok: upstream.ok, status: upstream.status, data },
    { status: upstream.ok ? 200 : 502 },
  );
}
