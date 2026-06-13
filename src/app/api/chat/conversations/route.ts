import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listConversations,
  createDirectConversation,
  createGroupConversation,
  ChatValidationError,
  MAX_GROUP_MEMBERS,
} from '@/lib/db/internalChat';

export const runtime = 'nodejs';

// GET /api/chat/conversations — conversations the current user participates in,
// with last-message preview and unread counts. Scoped to the actor only.
export async function GET() {
  let actor: Actor;
  try {
    actor = await requirePermission('internal_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const items = await listConversations(actor.id);
  return NextResponse.json({ items });
}

// POST /api/chat/conversations — start a conversation.
//   direct: { type: 'direct', user_id }     → dedupes to an existing 1:1
//   group:  { type: 'group', name, member_ids: string[] }
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('internal_chat', 'view');
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
  const rec = (body ?? {}) as Record<string, unknown>;
  const type = rec.type;
  const actorName = actor.full_name ?? actor.username;

  try {
    if (type === 'direct') {
      const otherId = typeof rec.user_id === 'string' ? rec.user_id.trim() : '';
      if (!otherId) {
        return NextResponse.json({ error: 'user_id_required' }, { status: 400 });
      }
      if (otherId === actor.id) {
        return NextResponse.json({ error: 'cannot_chat_self' }, { status: 400 });
      }
      const { id, existed } = await createDirectConversation(actor.id, actorName, otherId);
      return NextResponse.json({ id, existed }, { status: existed ? 200 : 201 });
    }

    if (type === 'group') {
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name || name.length > 80) {
        return NextResponse.json({ error: 'invalid_name' }, { status: 400 });
      }
      const rawMembers = Array.isArray(rec.member_ids) ? rec.member_ids : [];
      const memberIds = rawMembers
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .filter((x) => x !== actor.id);
      if (memberIds.length === 0) {
        return NextResponse.json({ error: 'members_required' }, { status: 400 });
      }
      // +1 for the creator — bound the fan-out before touching the DB.
      if (memberIds.length + 1 > MAX_GROUP_MEMBERS) {
        return NextResponse.json({ error: 'too_many_members' }, { status: 400 });
      }
      const { id } = await createGroupConversation(actor.id, actorName, name, memberIds);
      return NextResponse.json({ id, existed: false }, { status: 201 });
    }

    return NextResponse.json({ error: 'invalid_type' }, { status: 400 });
  } catch (err) {
    if (err instanceof ChatValidationError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[POST /api/chat/conversations]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
