import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDebtorApartmentNumber } from '@/lib/db/debtors';
import { createComment, listCommentsByDebtor } from '@/lib/db/comments';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const notes = await listCommentsByDebtor(id);
  return NextResponse.json(notes);
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!session.user.is_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
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
    author_id: session.user.id,
    author_name: session.user.full_name || session.user.username,
    author_email: session.user.email,
  });

  return NextResponse.json(note, { status: 201 });
}
