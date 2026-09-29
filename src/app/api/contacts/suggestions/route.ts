import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { contactSuggestionsResolveSchema } from '@/lib/validation/requests';
import { listPendingSuggestions, resolveSuggestions } from '@/lib/db/contactSuggestions';

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
export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
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
  const resolved = await resolveSuggestions(body.data.ids, body.data.action, actor.id);
  const items = await listPendingSuggestions();
  return NextResponse.json({ resolved, items });
}
