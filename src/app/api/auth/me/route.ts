import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  return NextResponse.json({ user: session?.user ?? null });
}
