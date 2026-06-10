import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { generateResetToken } from '@/lib/auth/tokens';
import { sendResetPasswordEmail } from '@/services/email';
import { appUrl } from '@/lib/config';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { FORGOT_PASSWORD_MAX_PER_IP, AUTH_RATE_WINDOW_SEC } from '@/lib/constants';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    // Anti-enumeration: still respond ok even on bad input
    return NextResponse.json({ ok: true });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email) return NextResponse.json({ ok: true });

  // Rate limit by IP. To preserve anti-enumeration we still answer 200 but
  // skip all work (no DB lookup, no email) when the IP is over the limit.
  const { allowed } = await checkRateLimit('forgot:ip:' + clientIp(req), {
    max: FORGOT_PASSWORD_MAX_PER_IP,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  if (!allowed) return NextResponse.json({ ok: true });

  const user = await queryOne<{ id: string; email: string; full_name: string | null }>(
    `select id, email, full_name from public.users where lower(email) = lower($1) limit 1`,
    [email],
  );

  if (user) {
    const token = await generateResetToken(user.id);
    const origin = appUrl();
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    const userName = user.full_name?.trim() || user.email.split('@')[0] || 'משתמש';

    try {
      await sendResetPasswordEmail(user.email, { userName, resetUrl });
    } catch (err) {
      // Anti-enumeration: do not leak send failures to caller.
      console.error('[forgot-password] email send failed', err);
    }
  }

  // Always 200 to prevent enumeration
  return NextResponse.json({ ok: true });
}
