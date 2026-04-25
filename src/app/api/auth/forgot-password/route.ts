import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { generateResetToken } from '@/lib/auth/tokens';
import { sendPasswordReset } from '@/services/email';

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

  const user = await queryOne<{ id: string }>(
    `select id from public.users where lower(email) = lower($1) limit 1`,
    [email],
  );

  if (user) {
    const token = await generateResetToken(user.id);
    const origin = new URL(req.url).origin;
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    await sendPasswordReset(email, resetUrl);
  }

  // Always 200 to prevent enumeration
  return NextResponse.json({ ok: true });
}
