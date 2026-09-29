import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getContactFieldState } from '@/lib/db/contactSuggestions';

export const runtime = 'nodejs';

// GET /api/apartments/[apartment]/contact-fields — what the apartment card
// needs beside the resident fields themselves: the open Bllink suggestions and
// who last changed each field. One round trip, `contacts:view` like the list
// the card belongs to.
//
// No 404 on an unknown apartment on purpose: both answers are simply empty,
// and this endpoint is a decoration on a card that already exists.
export async function GET(_req: Request, { params }: { params: Promise<{ apartment: string }> }) {
  try {
    await requirePermission('contacts', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { apartment } = await params;
  return NextResponse.json(await getContactFieldState(apartment));
}
