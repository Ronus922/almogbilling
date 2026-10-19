import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

// The /issues kanban, rewritten 12/10/2026 for the reference board (ref/
// issues-board.html): lanes are now per PRIMARY ASSIGNEE (one per employee +
// one combined "ספקים" lane), never per status — the OLD board_column/
// "ממתין לשיוך"/"היום"/"בטיפול"/"בוצע" columns this file used to drive are
// gone (board_column is no longer read by the UI at all). /tasks renders the
// exact same board component (WorkItemsBoard) against its own table — this
// file only exercises /issues; the DnD logic itself is shared, not per-kind.
//
// Pinned invariants (Decisions Log 12/10/2026, point 5):
//   • a card dropped on a DIFFERENT employee lane reassigns it (incl. out of
//     "ממתינים לשיבוץ", which is itself just the null-assignee lane);
//   • a card dropped within its OWN lane, among SAME-priority-tier siblings,
//     reorders (sort_index) — never renumbers the others;
//   • a card can never cross priority tiers within the same lane — the drop
//     is rejected outright (treated as a no-op, nothing persisted);
//   • a drag is never a click (the edit panel stays closed); a plain click
//     opens it;
//   • "סמן כבוצע" (the hover action, not a drag) closes the item — the
//     reference card has no status chip/column to drop onto anymore.
//
// Every issue AND the one throwaway employee this file creates is recorded
// by id at creation and removed by that exact id (iron rule 12).

test.use({ viewport: { width: 1600, height: 1000 } });
test.describe.configure({ mode: 'serial' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);
const createdIssues: string[] = [];
let adminId = '';
let secondId = '';

const uniq = `e2e-kanban-${Date.now()}`;

test.beforeAll(async () => {
  const r = await pool.query<{ id: string }>(`select id from public.users where username = 'e2e-admin'`);
  adminId = r.rows[0]?.id ?? '';
  expect(adminId, 'seeded e2e-admin').not.toBe('');
});

test.afterAll(async () => {
  for (const id of createdIssues) {
    await pool.query(`delete from public.notifications where source_entity_type = 'issue' and source_entity_id = $1`, [id]);
    await pool.query(`delete from public.entity_assignees where entity_type = 'issue' and entity_id = $1`, [id]);
    await pool.query(`delete from public.issues where id = $1`, [id]);
  }
  if (secondId) await pool.query(`delete from public.users where id = $1`, [secondId]);
  await pool.query(`delete from public.user_work_board_order where user_id = $1 and kind = 'issue'`, [adminId]);
  await pool.end();
});

/** A staff issue through the real route, created with `assignees: []`, so
 *  every fixture starts in "ממתינים לשיבוץ" regardless of `priority`. (Since
 *  19/10/2026 a create with exactly ONE assignee also sets the primary and
 *  lands in that column — the old "known gap" is closed; that path is pinned
 *  in e2e/kanban-board-update.spec.ts. These DnD fixtures want the strip.) */
async function newIssue(request: APIRequestContext, title: string, priority: 'normal' | 'high' | 'urgent' = 'normal') {
  const res = await request.post('/api/issues', {
    data: { title: `E2E קנבן · ${title}`, priority, due_date: null, assignees: [] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { issue } = (await res.json()) as { issue: { id: string } };
  createdIssues.push(issue.id);
  return issue;
}

async function readIssue(request: APIRequestContext, id: string) {
  const res = await request.get(`/api/issues/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    issue: { id: string; status_v2: string; assignee_user_id: string | null; sort_index: number | null };
  };
}

const card = (page: Page, id: string) => page.locator(`[data-work-item-id="${id}"]`);
const lane = (page: Page, key: string) => page.locator(`[data-lane="${key}"]`);

/** Position-in-lane as the DOM shows it, filtered to this file's own cards. */
async function orderIn(page: Page, laneKey: string, mine: string[]): Promise<string[]> {
  const ids = await lane(page, laneKey).locator('[data-work-item-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-work-item-id') ?? ''));
  return ids.filter((id) => mine.includes(id));
}

/** Drag `id` onto `target` (another card, to land above it, or a lane's
 *  empty area), waiting for the server's write. A drag is never a click. */
async function dragTo(
  page: Page,
  id: string,
  target: { aboveCard: string } | { emptyLane: string },
  expectWrite: boolean,
) {
  const write = page.waitForResponse((r) =>
    /\/api\/work-items\/issue\/[0-9a-f-]{36}\/(assignee|move)$/.test(r.url()) && r.request().method() === 'PATCH');
  if ('aboveCard' in target) {
    await card(page, id).dragTo(card(page, target.aboveCard), { targetPosition: { x: 60, y: 4 } });
  } else {
    // The lane is a fixed 80vh (19/10/2026), so its bottom can be below the
    // fold: aim at the empty area just above whichever is nearer, the lane's
    // bottom edge or the viewport's.
    await lane(page, target.emptyLane).scrollIntoViewIfNeeded();
    const box = await lane(page, target.emptyLane).boundingBox();
    if (!box) throw new Error(`lane ${target.emptyLane} is not on screen`);
    const viewportH = page.viewportSize()?.height ?? 900;
    const y = Math.max(10, Math.min(box.height - 10, viewportH - box.y - 10));
    await card(page, id).dragTo(lane(page, target.emptyLane), { targetPosition: { x: 40, y } });
  }
  if (expectWrite) expect((await write).status(), 'the drop persisted').toBe(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openBoard(page: Page, firstCard: string) {
  await page.goto('/issues');
  await expect(card(page, firstCard)).toBeVisible();
}

test('a second employee exists so a cross-lane reassignment has somewhere to go', async ({ page }) => {
  const res = await page.request.post('/api/users', {
    data: { email: `${uniq}@billing.local`, full_name: `עובד שני ${uniq}`, role: 'manager', password: 'E2e-Temp0rary!' },
  });
  expect(res.status(), await res.text()).toBe(201);
  secondId = ((await res.json()) as { id: string }).id;

  // Decision 3 (13/10/2026): a lane with zero open items is hidden by
  // default, "accessible through customization" — pin both so the rest of
  // this file's drag targets exist before either has a single open item.
  const pin = await page.request.put('/api/work-items/issue/board-preferences', {
    data: { employeeIds: [adminId, secondId] },
  });
  expect(pin.status(), await pin.text()).toBe(200);
});

test('an unassigned card sits in "ממתינים לשיבוץ"; dragging it into a lane assigns it', async ({ page }) => {
  const x = await newIssue(page.request, 'שיבוץ ראשוני');
  await openBoard(page, x.id);
  expect(await orderIn(page, 'unassigned', [x.id])).toEqual([x.id]);

  await dragTo(page, x.id, { emptyLane: `user:${adminId}` }, true);
  await expect.poll(() => orderIn(page, 'unassigned', [x.id])).toEqual([]);
  expect((await readIssue(page.request, x.id)).issue.assignee_user_id).toBe(adminId);
});

test('dragging a card to a DIFFERENT employee lane reassigns it', async ({ page }) => {
  const x = await newIssue(page.request, 'החלפת אחראי');
  await openBoard(page, x.id);
  await dragTo(page, x.id, { emptyLane: `user:${adminId}` }, true);
  expect((await readIssue(page.request, x.id)).issue.assignee_user_id).toBe(adminId);

  await dragTo(page, x.id, { emptyLane: `user:${secondId}` }, true);
  await expect.poll(async () => (await readIssue(page.request, x.id)).issue.assignee_user_id).toBe(secondId);
});

test('within the SAME lane, among same-priority siblings, a drag reorders (survives a reload)', async ({ page }) => {
  const a = await newIssue(page.request, 'סידור א');
  const b = await newIssue(page.request, 'סידור ב');
  const c = await newIssue(page.request, 'סידור ג');
  const mine = [a.id, b.id, c.id];
  await openBoard(page, a.id);
  for (const item of [a, b, c]) await dragTo(page, item.id, { emptyLane: `user:${adminId}` }, true);

  await dragTo(page, a.id, { aboveCard: c.id }, true);
  await expect.poll(() => orderIn(page, `user:${adminId}`, mine)).toEqual([a.id, c.id, b.id]);

  await page.reload();
  await expect(card(page, a.id)).toBeVisible();
  expect(await orderIn(page, `user:${adminId}`, mine)).toEqual([a.id, c.id, b.id]);
});

test('a card can never cross priority tiers within the same lane — the drop is rejected', async ({ page }) => {
  const low = await newIssue(page.request, 'דחיפות רגילה', 'normal');
  const high = await newIssue(page.request, 'דחיפות דחופה', 'urgent');
  await openBoard(page, low.id);
  await dragTo(page, low.id, { emptyLane: `user:${adminId}` }, true);
  await dragTo(page, high.id, { emptyLane: `user:${adminId}` }, true);

  // Dropping the normal-priority card directly above the urgent one, in the
  // SAME lane, spans tiers — the move route itself must reject it, so no
  // PATCH /move 200 should even fire; assert the server state is untouched.
  const beforeLow = await readIssue(page.request, low.id);
  const beforeHigh = await readIssue(page.request, high.id);
  await card(page, low.id).dragTo(card(page, high.id), { targetPosition: { x: 60, y: 4 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const afterLow = await readIssue(page.request, low.id);
  const afterHigh = await readIssue(page.request, high.id);
  expect(afterLow.issue.sort_index).toBe(beforeLow.issue.sort_index);
  expect(afterHigh.issue.sort_index).toBe(beforeHigh.issue.sort_index);
});

test('"סמן כבוצע" (hover action, not a drag) closes the item', async ({ page }) => {
  const x = await newIssue(page.request, 'לסגירה');
  await openBoard(page, x.id);
  await dragTo(page, x.id, { emptyLane: `user:${adminId}` }, true);

  const write = page.waitForResponse((r) =>
    /\/api\/work-items\/issue\/[0-9a-f-]{36}\/status$/.test(r.url()) && r.request().method() === 'PATCH');
  await card(page, x.id).hover();
  await card(page, x.id).getByTitle('סמן כבוצע').click();
  expect((await write).status()).toBe(200);
  expect((await readIssue(page.request, x.id)).issue.status_v2).toBe('closed');
});

test('a click (not a drag) opens the issue panel', async ({ page }) => {
  const x = await newIssue(page.request, 'לחיצה');
  await openBoard(page, x.id);
  await dragTo(page, x.id, { emptyLane: `user:${adminId}` }, true);
  await card(page, x.id).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'עריכת תקלה' })).toBeVisible();
});
