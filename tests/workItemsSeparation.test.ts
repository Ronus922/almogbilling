import { beforeEach, describe, expect, it, vi } from 'vitest';

// תקלות/משימות — "אפס ערבוב נתונים" (Decisions Log 12/10/2026, point 1): each
// screen's list/board/KPI query touches ONLY its own table. The 11/10/2026
// unified module read both via one `issues UNION ALL tasks` CTE; that CTE is
// gone (src/lib/db/workItems.ts: ISSUE_CTE and TASK_CTE are two separate
// `with scoped as (...)` blocks, never combined). This pins it at the SQL
// level — a plain string assertion, not a DB round-trip, since the shape
// itself is the invariant, not any particular row.

const captured: { sql: string; params: unknown[] }[] = [];

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return { rows: [] };
  }),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/db/entityAssignees', () => ({
  assigneesJsonExpr: (kind: string, alias: string) => `'[]'::json as assignees /* ${kind} ${alias} */`,
  assigneeExistsSql: () => '1=0',
}));

const { listWorkItems, getWorkItemKpis } = await import('@/lib/db/workItems');

const actor = { role: 'super_admin' as const, id: 'u-A' };

beforeEach(() => { captured.length = 0; });

describe('listWorkItems — per-kind query, never a combined one', () => {
  it('kind="issue" reads public.issues only — never public.tasks', async () => {
    await listWorkItems('issue', { tab: 'active' }, actor);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain('from public.issues');
    expect(captured[0]!.sql).not.toContain('public.tasks');
    expect(captured[0]!.sql).not.toContain('union');
  });

  it('kind="task" reads public.tasks only — never public.issues', async () => {
    await listWorkItems('task', { tab: 'active' }, actor);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain('from public.tasks');
    expect(captured[0]!.sql).not.toContain('public.issues');
    expect(captured[0]!.sql).not.toContain('union');
  });
});

describe('getWorkItemKpis — same per-kind rule for the KPI query', () => {
  it('kind="issue" never touches public.tasks', async () => {
    await getWorkItemKpis('issue', actor);
    expect(captured[0]!.sql).toContain('from public.issues');
    expect(captured[0]!.sql).not.toContain('public.tasks');
  });

  it('kind="task" never touches public.issues', async () => {
    await getWorkItemKpis('task', actor);
    expect(captured[0]!.sql).toContain('from public.tasks');
    expect(captured[0]!.sql).not.toContain('public.issues');
  });
});
