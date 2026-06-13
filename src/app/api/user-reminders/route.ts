import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listUserReminders,
  createUserReminder,
} from '@/lib/db/userReminders';
import { coerceUserReminderInput } from '@/lib/validation/userReminders';
import { writeAudit } from '@/lib/db/audit';
import type { UserReminderStatus, UserReminderWritableFields } from '@/lib/types/userReminders';

export const runtime = 'nodejs';

const STATUSES: readonly UserReminderStatus[] = ['pending', 'done', 'dismissed'];

// GET /api/user-reminders?status&assignedTo&entityType&entityId&due  (user_reminders:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('user_reminders', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  const statusRaw = sp.get('status')?.trim();
  const status =
    statusRaw && statusRaw !== 'all' && STATUSES.includes(statusRaw as UserReminderStatus)
      ? (statusRaw as UserReminderStatus)
      : undefined;

  const assignedToRaw = sp.get('assignedTo')?.trim();
  const assignedTo = assignedToRaw && assignedToRaw !== 'all' ? assignedToRaw : undefined;

  const entityType = sp.get('entityType')?.trim() || undefined;
  const entityId = sp.get('entityId')?.trim() || undefined;
  const due = sp.get('due') === '1';

  const items = await listUserReminders({ status, assignedTo, entityType, entityId, due });
  return NextResponse.json({ items });
}

// POST /api/user-reminders  (user_reminders:edit)
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

  const result = coerceUserReminderInput(bodyRec, 'create');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  try {
    const reminder = await createUserReminder(
      result.fields as Partial<UserReminderWritableFields> & { title: string; remind_at: string },
      actor.id,
    );

    await writeAudit({
      actorUserId: actor.id,
      action: 'created',
      entityType: 'reminder',
      entityId: reminder.id,
      changes: { after: reminder },
    });

    return NextResponse.json({ reminder }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[POST /api/user-reminders]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
