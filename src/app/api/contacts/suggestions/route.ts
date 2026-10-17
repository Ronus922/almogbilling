import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { contactSuggestionsResolveSchema } from '@/lib/validation/requests';
import { listPendingSuggestions, resolveSuggestions } from '@/lib/db/contactSuggestions';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// The Bllink approval queue.
//
// RBAC mirrors the residents list itself, exactly as asked: seeing the queue
// goes with seeing the list (contacts:view), deciding goes with editing it
// (contacts:edit) — the same guard /api/contacts uses for a create.

// GET /api/contacts/suggestions — contacts:view.
export async function GET() {
  try {
    await requirePermission('contacts', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const items = await listPendingSuggestions();
  return NextResponse.json({ items });
}

// POST /api/contacts/suggestions — contacts:edit. { action, ids }
//   approve / reject — several ids allowed; approving several resolves only
//     what does not change portal access, UNLESS every id names the SAME
//     phone on the same field (portal_link/portal_unlink) — one phone's
//     several apartments is one decision, not an unrelated batch (the SQL
//     enforces both rules — contact_suggestion_resolve);
//   approve_rename / approve_replace — ONE owner-name suggestion: "תיקון שם"
//     or "החלפת בעלים" (its dialog reads ./replacement first).
export async function POST(req: Request) {
  let actorId: string;
  try {
    actorId = (await requirePermission('contacts', 'edit')).id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, contactSuggestionsResolveSchema);
  if (!body.ok) return body.response;

  // Resolving is idempotent: an id someone else already decided — or that
  // closed itself because the value arrived by another route — simply is not
  // counted, so a double click cannot write a value twice.
  const { ids, action } = body.data;
  let resolved: number;
  try {
    resolved = await resolveSuggestions(ids, action, actorId);
  } catch (err) {
    logger.error('[POST /api/contacts/suggestions]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const items = await listPendingSuggestions();
  return NextResponse.json({ resolved, items });
}
