import { NextResponse } from 'next/server';
import { requireActor, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';

export const runtime = 'nodejs';

export async function GET() {
  let actor: Actor;
  try {
    actor = await requireActor();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  return NextResponse.json({
    user: {
      id: actor.id,
      username: actor.username,
      email: actor.email,
      full_name: actor.full_name,
      role: actor.role,
    },
  });
}
