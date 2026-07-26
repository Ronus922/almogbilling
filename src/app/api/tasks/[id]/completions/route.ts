import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listCompletionsForTask } from '@/lib/db/taskCompletions';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/completions — the occurrence history of a recurring task
// (migration 067). Under the single-row model the task row only knows its CURRENT
// occurrence, so "what was already done" lives in task_occurrence_completions.
// Reuses the tasks:view layer — no new permission.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const completions = await listCompletionsForTask(id);
  return NextResponse.json({ completions });
}
