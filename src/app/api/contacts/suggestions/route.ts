import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { contactSuggestionsResolveSchema } from '@/lib/validation/requests';
import { listPendingSuggestions, resolveSuggestions, suggestionApartments } from '@/lib/db/contactSuggestions';
import { withTransaction } from '@/lib/db';
import { logger } from '@/lib/logger';
import { phoneEntryErrorResponse, withPhoneEntryCheck } from '@/lib/http/phoneEntry';

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
//     what does not change portal access (the SQL enforces it);
//   approve_rename / approve_replace — ONE owner-name suggestion: "תיקון שם"
//     or "החלפת בעלים" (its dialog reads ./replacement first).
// An approval writes to the apartment card, so it runs under the card's entry
// warning (lib/http/phoneEntry.ts): a phone — or a name over a phone — that
// another apartment carries under another name → 409 phone_conflict, nothing
// resolved; the screen asks "אותו אדם?" and resends with phone_decisions.
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
  const { ids, action, phone_decisions: decisions } = body.data;
  let resolved: number;
  try {
    resolved = action === 'reject'
      ? await resolveSuggestions(ids, action, actor.id)
      : await withTransaction(async (client) => {
        const apartments = await suggestionApartments(client, ids);
        return withPhoneEntryCheck(client, { apartments, decisions, actor }, async () => ({
          result: await resolveSuggestions(ids, action, actor.id, client),
          apartments,
        }));
      });
  } catch (err) {
    const warn = phoneEntryErrorResponse(err, actor);
    if (warn) return warn;
    logger.error('[POST /api/contacts/suggestions]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const items = await listPendingSuggestions();
  return NextResponse.json({ resolved, items });
}
