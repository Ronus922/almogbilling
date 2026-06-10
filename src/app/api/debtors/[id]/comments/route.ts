import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorApartmentNumber } from '@/lib/db/debtors';
import { createComment, listCommentsByDebtor } from '@/lib/db/comments';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('dashboard', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const notes = await listCommentsByDebtor(id);
  return NextResponse.json(notes);
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('dashboard', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: { content?: unknown };
  try {
    body = (await req.json()) as { content?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const raw = typeof body.content === 'string' ? body.content : '';
  const content = raw.trim();
  if (content.length === 0) {
    return NextResponse.json({ error: 'empty_content' }, { status: 400 });
  }

  const apt = await getDebtorApartmentNumber(id);
  if (!apt) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const note = await createComment({
    debtor_id: id,
    apartment_number: apt,
    content,
    author_id: actor.id,
    author_name: actor.full_name || actor.username,
    author_email: actor.email,
  });

  return NextResponse.json(note, { status: 201 });
}
