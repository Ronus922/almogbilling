import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listContacts, createContact, ConflictError } from '@/lib/db/contacts';
import { coerceContactInput } from '@/lib/validation/contacts';
import type { ContactSort, ContactWritableFields } from '@/lib/types/contacts';

export const runtime = 'nodejs';

const SORTS: readonly ContactSort[] = [
  'apartment_asc', 'apartment_desc', 'updated_desc', 'created_desc',
];

// GET /api/contacts?search&tags&sort — any authenticated user.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const search = sp.get('search')?.trim() || undefined;

  const tagsRaw = sp.get('tags')?.trim();
  const tags = tagsRaw
    ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;

  const sortRaw = sp.get('sort')?.trim();
  const sort = sortRaw && SORTS.includes(sortRaw as ContactSort)
    ? (sortRaw as ContactSort)
    : undefined;

  const items = await listContacts({ search, tags, sort });
  return NextResponse.json({ items });
}

// POST /api/contacts — contacts:edit.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = coerceContactInput((body ?? {}) as Record<string, unknown>, 'create');
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const contact = await createContact(
      result.fields as Partial<ContactWritableFields> & { apartment_number: string },
      actor.id,
    );
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    if (err instanceof ConflictError) {
      return NextResponse.json({ error: 'apartment_number_exists' }, { status: 409 });
    }
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[POST /api/contacts]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
