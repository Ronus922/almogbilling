import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { ownerReplacementQuerySchema } from '@/lib/validation/requests';
import { getOwnerReplacementPreview } from '@/lib/db/contactSuggestions';

export const runtime = 'nodejs';

// GET /api/contacts/suggestions/replacement?id= — what "החלפת בעלים" will do
// for one owner-name suggestion: the previous owner's phones it detaches and
// the new owner's phone it approves with it. Read-only, for the confirmation
// dialog; the approval itself applies the same SQL function. contacts:edit —
// it is the first step of an edit.
export async function GET(req: Request) {
  try {
    await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const parsed = ownerReplacementQuerySchema.safeParse({ id: new URL(req.url).searchParams.get('id') });
  if (!parsed.success) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const preview = await getOwnerReplacementPreview(parsed.data.id);
  if (!preview) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ preview });
}
