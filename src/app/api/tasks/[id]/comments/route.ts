import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listTaskComments, createTaskComment, getTaskById } from '@/lib/db/tasks';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/comments  (tasks:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const comments = await listTaskComments(id);
  return NextResponse.json({ comments });
}

// POST /api/tasks/[id]/comments — viewers may comment (tasks:view), per module spec.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const content = typeof (body as { content?: unknown })?.content === 'string'
    ? (body as { content: string }).content.trim()
    : '';
  if (!content) return NextResponse.json({ error: 'content_required' }, { status: 400 });
  if (content.length > 5000) return NextResponse.json({ error: 'content_too_long' }, { status: 400 });

  const task = await getTaskById(id);
  if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const comment = await createTaskComment(
    id,
    content,
    actor.id,
    actor.full_name ?? actor.username,
  );
  return NextResponse.json({ comment }, { status: 201 });
}
