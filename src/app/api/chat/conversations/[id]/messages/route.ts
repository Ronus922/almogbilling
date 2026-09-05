import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getThreadForParticipant, postMessage } from '@/lib/db/internalChat';
import { MAX_MESSAGE_LENGTH } from '@/lib/types/internalChat';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// GET /api/chat/conversations/[id]/messages?since=<iso>
//   Returns the thread (or only messages newer than `since`) — ONLY if the
//   current user participates in the conversation. Otherwise 403 (no IDOR).
//   Side effect: advances the user's read cursor (marks read).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let actor: Actor;
  try {
    actor = await requirePermission('internal_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await params;
  const since = req.nextUrl.searchParams.get('since');
  // Validate `since` is a parseable ISO timestamp; ignore garbage rather than
  // 500 inside the query.
  const sinceIso = since && !Number.isNaN(Date.parse(since)) ? since : null;

  const payload = await getThreadForParticipant(id, actor.id, sinceIso);
  if (!payload) {
    // Not a participant (or conversation gone) — uniform 403, no existence leak.
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json(payload);
}

// POST /api/chat/conversations/[id]/messages  { content }
//   Append a message — ONLY if the current user participates. Validates length
//   (1..4000). Fans out notifications to the other participants in a tx.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let actor: Actor;
  try {
    actor = await requirePermission('internal_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const rec = (body ?? {}) as Record<string, unknown>;
  const content = typeof rec.content === 'string' ? rec.content : '';
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return NextResponse.json({ error: 'empty_content' }, { status: 400 });
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: 'content_too_long' }, { status: 400 });
  }

  try {
    const message = await postMessage(id, { id: actor.id, name: actor.full_name ?? actor.username }, trimmed);
    if (!message) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_content') {
      return NextResponse.json({ error: 'invalid_content' }, { status: 400 });
    }
    logger.error('[POST /api/chat/conversations/[id]/messages]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
