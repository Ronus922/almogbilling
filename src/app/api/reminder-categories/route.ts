import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listReminderCategoriesWithCounts,
  createReminderCategory,
} from '@/lib/db/reminderCategories';
import { coerceReminderCategoryInput } from '@/lib/validation/reminderCategories';
import { writeAudit } from '@/lib/db/audit';
import type { ReminderCategoryWritableFields } from '@/lib/types/reminderCategories';

export const runtime = 'nodejs';

// Reminder categories reuse the existing user_reminders RBAC module — they are
// part of the same user-facing Reminders feature, not a standalone module.

// GET /api/reminder-categories  (user_reminders:view)
// Returns active categories with their open-reminder counts (scoped to the
// viewer — counts only reminders involving the current actor).
export async function GET() {
  let actor: Actor;
  try {
    actor = await requirePermission('user_reminders', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const items = await listReminderCategoriesWithCounts(actor.id);
  return NextResponse.json({ items });
}

// POST /api/reminder-categories  (user_reminders:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('user_reminders', 'edit');
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
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceReminderCategoryInput(bodyRec, 'create');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  try {
    const category = await createReminderCategory(
      result.fields as Partial<ReminderCategoryWritableFields> & { name: string; color: string },
      actor.id,
    );

    await writeAudit({
      actorUserId: actor.id,
      action: 'created',
      entityType: 'reminder_category',
      entityId: category.id,
      changes: { after: category },
    });

    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[POST /api/reminder-categories]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
