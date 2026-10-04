import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { withTransaction } from '@/lib/db';
import {
  getSupplierById, updateSupplier, softDeleteSupplier, replaceSupplierContacts,
} from '@/lib/db/suppliers';
import {
  coerceAndValidateSupplier, supplierChangedFields, supplierContactsChanged,
} from '@/lib/validation/suppliers';
import { supplierContactsSchema } from '@/lib/validation/requests';
import { writeAudit } from '@/lib/db/audit';
import { logger } from '@/lib/logger';
import type { SupplierContactInput } from '@/lib/types/suppliers';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/suppliers/[id] (suppliers:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const supplier = await getSupplierById(id);
  if (!supplier) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ supplier });
}

// PATCH /api/suppliers/[id] (suppliers:edit) — whole-object save.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit');
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

  const rec = (body ?? {}) as Record<string, unknown>;
  const result = coerceAndValidateSupplier(rec);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Additional contacts: the edit form sends the whole list. An ABSENT key
  // leaves them untouched — the archive/restore button PATCHes the supplier
  // without it, and so does any client that predates the field.
  let contacts: SupplierContactInput[] | null = null;
  if (rec.additional_contacts !== undefined) {
    const parsed = supplierContactsSchema.safeParse(rec.additional_contacts);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      return NextResponse.json(
        { error: issues[0]?.message ?? 'invalid_additional_contacts', issues },
        { status: 400 },
      );
    }
    contacts = parsed.data;
  }

  try {
    const before = await getSupplierById(id);
    if (!before) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const contactsChanged =
      contacts !== null && supplierContactsChanged(before.additional_contacts, contacts);

    const updated = await withTransaction(async (client) => {
      const row = await updateSupplier(id, result.fields, client);
      if (row && contacts && contactsChanged) await replaceSupplierContacts(client, id, contacts);
      return row;
    });
    if (!updated) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Activity log: one row per save. A status flip to/from 'archived' is
    // recorded as a distinct verb; any other field change is 'updated' with the
    // list of changed field keys (the UI renders Hebrew labels, not raw values).
    const changed: string[] = supplierChangedFields(before, result.fields);
    if (contactsChanged) changed.push('additional_contacts');
    if (changed.length > 0) {
      const statusFlipped = before.status !== result.fields.status;
      const action = statusFlipped
        ? result.fields.status === 'archived' ? 'archived' : 'restored'
        : 'updated';
      await writeAudit({
        actorUserId: actor.id,
        action,
        entityType: 'supplier',
        entityId: id,
        changes: { fields: changed },
      });
    }

    // Re-read after COMMIT so the response carries the saved additional
    // contacts (the panel replaces its state with it).
    const supplier = await getSupplierById(id);
    if (!supplier) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ supplier });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
    logger.error('[PATCH /api/suppliers/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/suppliers/[id] (suppliers:edit) — soft delete.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const before = await getSupplierById(id);
  const ok = await softDeleteSupplier(id);
  if (!ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'supplier',
    entityId: id,
    metadata: before ? { display_name: before.display_name } : undefined,
  });
  return NextResponse.json({ ok: true });
}
