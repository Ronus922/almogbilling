import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryOne } from '@/lib/db';
import {
  findStatusByLowerName,
  updateStatus,
  deleteStatus,
  countLinkedDebtors,
} from '@/lib/db/statuses';
import { validateStatusForm } from '@/lib/validation/status';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// PATCH /api/statuses/[id] (admin)
// Full-form replace (not partial) — matches the form's "save" semantics.
// is_system rows: name/description/color/notification_emails are editable;
// is_active and is_default cannot be turned off.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!session.user.is_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await ctx.params;

  const existing = await getStatusByIdRaw(id);
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = validateStatusForm(body as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: 'validation', errors: result.errors }, { status: 400 });
  }

  // System rows: name/description/color/notification_emails are editable.
  // is_active cannot be turned off (the system status is always active).
  // is_default is no longer in the contract — silently ignored if present.
  if (existing.is_system && result.value.is_active === false) {
    return NextResponse.json(
      { error: 'forbidden', message: 'לא ניתן להשבית סטטוס מערכת' },
      { status: 403 },
    );
  }

  const clash = await findStatusByLowerName(result.value.name, id);
  if (clash) {
    return NextResponse.json(
      { error: 'name_taken', message: 'סטטוס בשם זה כבר קיים', field: 'name' },
      { status: 409 },
    );
  }

  try {
    const updated = await updateStatus(id, result.value, { userId: session.user.id });
    return NextResponse.json(updated);
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'statuses_name_key') {
      return NextResponse.json(
        { error: 'name_taken', message: 'סטטוס בשם זה כבר קיים', field: 'name' },
        { status: 409 },
      );
    }
    console.error('[PATCH /api/statuses/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/statuses/[id] (admin)
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!session.user.is_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await ctx.params;
  const existing = await getStatusByIdRaw(id);
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (existing.is_system) {
    return NextResponse.json(
      { error: 'forbidden', message: 'לא ניתן למחוק סטטוס מערכת' },
      { status: 403 },
    );
  }
  const linked = await countLinkedDebtors(id);
  if (linked > 0) {
    return NextResponse.json(
      { error: 'has_linked', message: 'הסטטוס משויך לדיירים', linked_count: linked },
      { status: 409 },
    );
  }

  try {
    await deleteStatus(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as { code?: string };
    // ON DELETE RESTRICT race-guard — if a debtor was linked between count and delete.
    if (e.code === '23503') {
      const after = await countLinkedDebtors(id);
      return NextResponse.json(
        { error: 'has_linked', message: 'הסטטוס משויך לדיירים', linked_count: after },
        { status: 409 },
      );
    }
    console.error('[DELETE /api/statuses/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

async function getStatusByIdRaw(id: string) {
  return queryOne<{ id: string; is_system: boolean; name: string }>(
    `select id, is_system, name from public.statuses where id = $1`,
    [id],
  );
}
