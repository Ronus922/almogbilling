import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

// "התאמת לוח" + list-row drag (13/10/2026, decisions 2 and 6) — two drag
// channels this repo did not have before today: dragging a lane HEADER
// reorders the employee columns themselves (persisted per-user, per-module,
// public.user_work_board_order), and dragging a row's handle in the LIST view
// (`.wb-handle-row`, DESIGN.md §41) reorders it through the exact same
// same-lane/same-priority-tier endpoint the board's own card drag already
// uses (PATCH /api/work-items/[kind]/[id]/move) — e2e/issues-kanban-dnd.spec.ts
// covers that endpoint's semantics (cross-lane reassign, cross-tier rejection)
// against the board; this file does not re-prove them, only that the LIST's
// new drag handle reaches the same endpoint correctly. Also pins decision 5
// (full-viewport-height columns, the board's own scroll — not the page's).
//
// 14/10/2026, "התאמת לוח — ספקים + בחירה מפורשת גוברת": the suppliers lane
// is now a normal row in the same popover, pinnable/hideable exactly like an
// employee lane — see tests at the bottom of this file.
//
// Every issue, the one throwaway employee and the one throwaway supplier this
// file creates are recorded by id at creation and removed by that exact id
// (iron rule 12).

test.use({ viewport: { width: 1600, height: 1000 } });
test.describe.configure({ mode: 'serial' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);
const createdIssues: string[] = [];
let adminId = '';
let secondId = '';
let supplierId = '';

const uniq = `e2e-board-order-${Date.now()}`;

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
  await pool.query(`delete from public.user_work_board_order where user_id = $1 and kind = 'issue'`, [adminId]);
  if (secondId) await pool.query(`delete from public.users where id = $1`, [secondId]);
  if (supplierId) await pool.query(`delete from public.suppliers where id = $1`, [supplierId]);
  await pool.end();
});

async function newIssue(request: APIRequestContext, title: string, priority: 'normal' | 'high' | 'urgent' = 'normal') {
  const res = await request.post('/api/issues', {
    data: { title: `E2E לוח · ${title}`, priority, due_date: null, assignees: [] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { issue } = (await res.json()) as { issue: { id: string } };
  createdIssues.push(issue.id);
  return issue;
}

async function assign(request: APIRequestContext, id: string, userId: string) {
  const res = await request.patch(`/api/work-items/issue/${id}/assignee`, { data: { assignee: { kind: 'user', id: userId } } });
  expect(res.status(), await res.text()).toBe(200);
}

async function assignSupplier(request: APIRequestContext, id: string, supplier: string) {
  const res = await request.patch(`/api/work-items/issue/${id}/assignee`, { data: { assignee: { kind: 'supplier', id: supplier } } });
  expect(res.status(), await res.text()).toBe(200);
}

async function unassign(request: APIRequestContext, id: string) {
  const res = await request.patch(`/api/work-items/issue/${id}/assignee`, { data: { assignee: null } });
  expect(res.status(), await res.text()).toBe(200);
}

const lane = (page: Page, key: string) => page.locator(`[data-lane="${key}"]`);
const laneHandle = (page: Page, key: string) => page.locator(`[data-lane-handle="${key}"]`);
/** The "ספקים" checkbox row inside the open "התאמת לוח" popover
 *  (BoardOrderPopover, `data-board-emp-id={SUPPLIERS_LANE_ID}`). */
const suppliersPopoverCheckbox = (page: Page) => page.locator('[data-board-emp-id="suppliers"] [role="checkbox"]');

async function openBoardOrderPopover(page: Page) {
  await page.getByRole('button', { name: 'התאמת לוח' }).click();
  await expect(suppliersPopoverCheckbox(page)).toBeVisible();
}
/** The board card (WorkItemsBoard) — visible in the default board view. */
const card = (page: Page, id: string) => page.locator(`[data-work-item-id="${id}"]`);
/** The list row (WorkListTable, its own attribute — the board and the list
 *  fallback both render in board view, see that component's comment) —
 *  visible once the "רשימה" toggle is clicked. */
const listRow = (page: Page, id: string) => page.locator(`[data-work-row-id="${id}"]`);

async function laneOrder(page: Page): Promise<string[]> {
  return page.locator('[data-lane]:not([data-lane="unassigned"])')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-lane') ?? ''));
}

test('a second employee exists so there are two lanes to reorder', async ({ page }) => {
  const res = await page.request.post('/api/users', {
    data: { email: `${uniq}@billing.local`, full_name: `עובד לוח ${uniq}`, role: 'manager', password: 'E2e-Temp0rary!' },
  });
  expect(res.status(), await res.text()).toBe(201);
  secondId = ((await res.json()) as { id: string }).id;
});

test('dragging a lane header reorders the columns and persists across reload', async ({ page }) => {
  const a = await newIssue(page.request, 'שיוך א');
  const b = await newIssue(page.request, 'שיוך ב');
  await assign(page.request, a.id, adminId);
  await assign(page.request, b.id, secondId);

  await page.goto('/issues');
  await expect(card(page, a.id)).toBeVisible();
  // Both have exactly 1 open item, so the default (decision 3) is a tie,
  // broken alphabetically — not re-asserted here (own unit test,
  // tests/workItemsBoardOrder.test.ts); just establish there ARE two lanes,
  // in SOME order, then drag the first onto the second to reverse it.
  const before = await laneOrder(page);
  expect([...before].sort()).toEqual([`user:${adminId}`, `user:${secondId}`].sort());
  const [first, second] = before;
  const after = [second, first];

  const write = page.waitForResponse((r) =>
    r.url().endsWith('/api/work-items/issue/board-preferences') && r.request().method() === 'PUT');
  // Drop on the RIGHT portion of `first`'s header (x=200 of a 255px-wide
  // lane, past its midpoint) — under dir="rtl" that reads as "before `first`"
  // (DOM/array order), landing `second` ahead of it: [second, first].
  await laneHandle(page, second!).dragTo(laneHandle(page, first!), { targetPosition: { x: 200, y: 4 } });
  expect((await write).status(), 'the new column order persisted').toBe(200);
  await expect.poll(() => laneOrder(page)).toEqual(after);

  await page.reload();
  await expect(card(page, a.id)).toBeVisible();
  expect(await laneOrder(page)).toEqual(after);
});

test('the board fills the viewport — the page itself does not scroll in board view', async ({ page }) => {
  await page.goto('/issues');
  await expect(lane(page, `user:${adminId}`)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow, 'no vertical page scroll with the board open').toBeLessThanOrEqual(1);
});

test('the list view’s row handle drags within the same lane and persists (same endpoint as the board)', async ({ page }) => {
  const a = await newIssue(page.request, 'רשימה א');
  const b = await newIssue(page.request, 'רשימה ב'); // created after a → sorts above it by default (created_at desc)
  await assign(page.request, a.id, adminId);
  await assign(page.request, b.id, adminId);

  await page.goto('/issues');
  await page.getByRole('button', { name: 'רשימה', exact: true }).click();
  await expect(listRow(page, a.id)).toBeVisible();
  const mineOf = (ids: (string | null)[]) => ids.filter((id): id is string => id === a.id || id === b.id);
  const initial = mineOf(await page.locator('[data-work-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-work-row-id'))));
  expect(initial, 'default order: newest first').toEqual([b.id, a.id]);

  // Drag the OLDER row (a) to land above the newer one (b) — reverses the
  // default, so this is a real move, not a drop back where it already is.
  const write = page.waitForResponse((r) =>
    /\/api\/work-items\/issue\/[0-9a-f-]{36}\/move$/.test(r.url()) && r.request().method() === 'PATCH');
  await listRow(page, a.id).dragTo(listRow(page, b.id), { targetPosition: { x: 60, y: 4 } });
  expect((await write).status(), 'the row drop persisted').toBe(200);
  await expect.poll(async () => mineOf(await page.locator('[data-work-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-work-row-id')))))
    .toEqual([a.id, b.id]);

  await page.reload();
  await page.getByRole('button', { name: 'רשימה', exact: true }).click();
  const order = mineOf(await page.locator('[data-work-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-work-row-id'))));
  expect(order).toEqual([a.id, b.id]);
});

test('a click on a row (not a drag) still expands it — the drag handle did not eat clicks', async ({ page }) => {
  const x = await newIssue(page.request, 'לחיצה ברשימה');
  await page.goto('/issues');
  await page.getByRole('button', { name: 'רשימה', exact: true }).click();
  await expect(listRow(page, x.id)).toBeVisible();
  await listRow(page, x.id).click();
  await expect(page.getByText('אין תיאור.')).toBeVisible();
});

// 14/10/2026, "התאמת לוח — ספקים + בחירה מפורשת גוברת" — the suppliers lane
// used to be driven purely by whether a live item was currently assigned to
// a supplier, with no saved preference able to override that: it vanished
// the moment its last open item left, and there was no way to pin it back.
// It is now a normal row in the popover (checkbox + drag, same mechanism as
// an employee), so an explicit choice overrides the default either way.

test('the suppliers lane is absent by default — no open supplier-assigned item yet, no saved preference', async ({ page }) => {
  await page.goto('/issues');
  await expect(lane(page, 'suppliers')).toHaveCount(0);
});

test('a supplier exists, for the suppliers-lane tests below', async () => {
  const r = await pool.query<{ id: string }>(
    `insert into public.suppliers (display_name, contact_person) values ($1, 'לוח התאמה') returning id`,
    [`ספק לוח ${uniq}`],
  );
  supplierId = r.rows[0]!.id;
});

test('an open supplier-assigned item makes the (uncustomized) suppliers lane appear by default', async ({ page }) => {
  const s = await newIssue(page.request, 'שיוך ספק');
  await assignSupplier(page.request, s.id, supplierId);

  await page.goto('/issues');
  await expect(lane(page, 'suppliers')).toBeVisible();
  await expect(card(page, s.id)).toBeVisible();

  // Back to unassigned — the default-driven lane disappears again, same as
  // before this feature existed. This is the baseline the fix below changes.
  await unassign(page.request, s.id);
  await page.reload();
  await expect(lane(page, 'suppliers')).toHaveCount(0);
});

test('pinning "ספקים" in "התאמת לוח" shows the lane even while empty — the fix', async ({ page }) => {
  await page.goto('/issues');
  await expect(lane(page, 'suppliers')).toHaveCount(0);

  await openBoardOrderPopover(page);
  const write = page.waitForResponse((r) =>
    r.url().endsWith('/api/work-items/issue/board-preferences') && r.request().method() === 'PUT');
  await suppliersPopoverCheckbox(page).click();
  expect((await write).status(), 'the pinned suppliers lane persisted').toBe(200);

  await expect(lane(page, 'suppliers')).toBeVisible();
  await expect(lane(page, 'suppliers').getByText('אין משימות פתוחות')).toBeVisible();

  await page.reload();
  await expect(lane(page, 'suppliers')).toBeVisible();
});

test('unchecking "ספקים" hides the lane even with an open supplier-assigned item in it', async ({ page }) => {
  const s = await newIssue(page.request, 'שיוך ספק ב');
  await assignSupplier(page.request, s.id, supplierId);

  await page.goto('/issues');
  await expect(lane(page, 'suppliers')).toBeVisible(); // still pinned from the previous test, now with an item too
  await expect(card(page, s.id)).toBeVisible();

  await openBoardOrderPopover(page);
  const write = page.waitForResponse((r) =>
    r.url().endsWith('/api/work-items/issue/board-preferences') && r.request().method() === 'PUT');
  await suppliersPopoverCheckbox(page).click(); // uncheck
  expect((await write).status()).toBe(200);

  await expect(lane(page, 'suppliers')).toHaveCount(0);

  await page.reload();
  await expect(lane(page, 'suppliers')).toHaveCount(0);
});
