import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getIssueById, listIssueComments, createIssueComment } from '@/lib/db/issues';
import { isUuid } from '@/lib/validation/issues';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/issues/[id]/comments  (issues:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('issues', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const comments = await listIssueComments(id);
  return NextResponse.json({ comments });
}

// POST /api/issues/[id]/comments  (issues:view — viewers can comment, per spec)
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;
  const content = typeof bodyRec.content === 'string' ? bodyRec.content.trim() : '';
  if (!content) return NextResponse.json({ error: 'content_required' }, { status: 400 });
  if (content.length > 5000) return NextResponse.json({ error: 'content_too_long' }, { status: 400 });

  const issue = await getIssueById(id);
  if (!issue) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const comment = await createIssueComment(
    id,
    content,
    actor.id,
    actor.full_name ?? actor.username,
  );
  return NextResponse.json({ comment }, { status: 201 });
}
