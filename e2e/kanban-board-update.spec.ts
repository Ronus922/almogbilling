import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

// Kanban update 19/10/2026 (ref/Kanva-issue/issues-board-kanban-update.md) on
// the shared board component, plus the server change that makes "created
// straight into a column" true:
//   1. the board is a fixed 80vh, columns stretch to it and scroll inside;
//   2. "ממתינים לשיבוץ" is a block (title row above the cards), and is not
//      rendered at all while empty;
//   3. every column header has a "+" (26×26, right of the count) that opens
//      the create form with the column's handler pre-filled and locked;
//   4. a create with ONE assignee also writes the primary assignee (the lane
//      key), so it lands in that column — from the "+" AND from the general
//      "תקלה חדשה" form. Two assignees, or none, still wait in the strip.
//
// Every issue/task, the throwaway employee and supplier are recorded by id at
// creation and removed by that exact id (iron rule 12).

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);
const createdIssues: string[] = [];
const createdTasks: string[] = [];
let adminId = '';
let secondId = '';
let supplierId = '';

const uniq = `e2e-kanban-upd-${Date.now()}`;
const SECOND_NAME = `עובד לוח ${uniq}`;
const SUPPLIER_NAME = `ספק לוח ${uniq}`;

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
  for (const id of createdTasks) {
    await pool.query(`delete from public.notifications where source_entity_type = 'task' and source_entity_id = $1`, [id]);
    await pool.query(`delete from public.entity_assignees where entity_type = 'task' and entity_id = $1`, [id]);
    await pool.query(`delete from public.tasks where id = $1`, [id]);
  }
  await pool.query(`delete from public.user_work_board_order where user_id = $1 and kind in ('issue','task')`, [adminId]);
  if (secondId) await pool.query(`delete from public.users where id = $1`, [secondId]);
  if (supplierId) await pool.query(`delete from public.suppliers where id = $1`, [supplierId]);
  await pool.end();
});

type Assignee = { assignee_type: 'user' | 'supplier'; id: string };

async function newIssue(
  request: APIRequestContext,
  title: string,
  opts: { priority?: 'normal' | 'high' | 'urgent'; assignees?: Assignee[] } = {},
) {
  const res = await request.post('/api/issues', {
    data: { title: `E2E ${uniq} · ${title}`, priority: opts.priority ?? 'normal', due_date: null, assignees: opts.assignees ?? [] },
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
    issue: { id: string; assignee_user_id: string | null; assignee_supplier_id: string | null; assignees: unknown[] };
  };
}

const card = (page: Page, id: string) => page.locator(`[data-work-item-id="${id}"]`);
const lane = (page: Page, key: string) => page.locator(`[data-lane="${key}"]`);
const strip = (page: Page) => page.locator('[data-lane="unassigned"]');
const addButton = (page: Page, key: string) => page.locator(`[data-add-lane="${key}"]`);
const board = (page: Page) => page.locator('[data-board-lanes]');

/** The "ללא שיוך" KPI card's number (it is a <button> wrapping the KpiCard). */
async function unassignedKpi(page: Page): Promise<number> {
  const text = await page.locator('button', { hasText: 'ללא שיוך' }).first().innerText();
  return Number(text.replace(/\D+/g, ' ').trim().split(' ')[0]);
}

async function createdTitle(page: Page, title: string) {
  await page.getByPlaceholder('מה התקלה?').fill(`E2E ${uniq} · ${title}`);
}

test('setup: a second employee and a supplier exist, both lanes pinned', async ({ page }) => {
  const res = await page.request.post('/api/users', {
    data: { email: `${uniq}@billing.local`, full_name: SECOND_NAME, role: 'manager', password: 'E2e-Temp0rary!' },
  });
  expect(res.status(), await res.text()).toBe(201);
  secondId = ((await res.json()) as { id: string }).id;
  const s = await pool.query<{ id: string }>(
    `insert into public.suppliers (display_name, contact_person) values ($1, 'לוח עדכון') returning id`,
    [SUPPLIER_NAME],
  );
  supplierId = s.rows[0]!.id;
  for (const kind of ['issue', 'task']) {
    const pin = await page.request.put(`/api/work-items/${kind}/board-preferences`, {
      data: { employeeIds: [adminId, secondId, 'suppliers'] },
    });
    expect(pin.status(), await pin.text()).toBe(200);
  }
});

test('"ממתינים לשיבוץ" is not rendered while nothing is unassigned', async ({ page }) => {
  await page.goto('/issues');
  await expect(lane(page, `user:${adminId}`)).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
});

test('the strip is a block: title row above a full-width card row, dashed amber frame, urgent badge on one line', async ({ page }) => {
  const a = await newIssue(page.request, 'ממתין רגיל');
  const b = await newIssue(page.request, 'ממתין דחוף', { priority: 'urgent' });
  await page.goto('/issues');
  await expect(card(page, a.id)).toBeVisible();

  const frame = strip(page);
  const css = await frame.evaluate((el) => {
    const s = getComputedStyle(el);
    // (the 1.5px border computes to 1px at devicePixelRatio 1 — Chrome snaps
    // border widths down — so the width is not asserted, the style/colour are)
    return { display: s.display, style: s.borderTopStyle, color: s.borderTopColor, bg: s.backgroundColor, radius: s.borderTopLeftRadius };
  });
  expect(css).toMatchObject({
    display: 'block', style: 'dashed', color: 'rgb(251, 228, 181)', bg: 'rgb(255, 253, 246)', radius: '14px',
  });

  const title = frame.getByText('ממתינים לשיבוץ', { exact: true });
  const titleBox = await title.boundingBox();
  const firstCardBox = await card(page, a.id).boundingBox();
  const frameBox = await frame.boundingBox();
  expect(titleBox && firstCardBox && frameBox).toBeTruthy();
  // The title is on its own row: the whole card row starts below it …
  expect(firstCardBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
  // … and the cards get the strip's full inner width (not width minus a title column).
  const row = await frame.locator('[data-work-item-id]').first().evaluate((el) => el.parentElement!.getBoundingClientRect().width);
  expect(row).toBeGreaterThan(frameBox!.width - 40);

  await expect(frame.locator('[data-unassigned-count]')).toHaveText(/^\d+$/);
  const urgent = frame.locator('[data-unassigned-urgent]');
  await expect(urgent).toContainText('דחופות');
  expect(await urgent.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');
  const urgentBox = await urgent.boundingBox();
  expect(urgentBox!.height, 'the badge text never wraps').toBeLessThan(30);

  // card tones by urgency
  expect(await card(page, b.id).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 246, 246)');
  expect(await card(page, a.id).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
});

test('assigning from the strip moves the card and every counter follows; the strip vanishes when empty', async ({ page }) => {
  await page.goto('/issues');
  const frame = strip(page);
  const startCount = Number(await frame.locator('[data-unassigned-count]').innerText());
  const startKpi = await unassignedKpi(page);
  expect(startCount).toBeGreaterThanOrEqual(2);
  expect(startKpi).toBe(startCount);

  const first = frame.locator('[data-work-item-id]').first();
  const id = (await first.getAttribute('data-work-item-id'))!;
  const write = page.waitForResponse((r) =>
    /\/api\/work-items\/issue\/[0-9a-f-]{36}\/assignee$/.test(r.url()) && r.request().method() === 'PATCH');
  await first.getByText('שיבוץ', { exact: true }).click();
  await page.getByRole('button', { name: SECOND_NAME, exact: true }).click();
  expect((await write).status()).toBe(200);

  await expect(lane(page, `user:${secondId}`).locator(`[data-work-item-id="${id}"]`)).toBeVisible();
  await expect(frame.locator('[data-unassigned-count]')).toHaveText(String(startCount - 1));
  await expect.poll(() => unassignedKpi(page)).toBe(startKpi - 1);

  // The urgent one left ⇒ no urgent badge if it was the urgent card; assign
  // every remaining card and the whole strip disappears.
  for (let left = startCount - 1; left > 0; left -= 1) {
    const next = frame.locator('[data-work-item-id]').first();
    await next.getByText('שיבוץ', { exact: true }).click();
    await page.getByRole('button', { name: SECOND_NAME, exact: true }).click();
    await expect(frame.locator('[data-work-item-id]')).toHaveCount(left - 1);
  }
  await expect(strip(page)).toHaveCount(0);
  await expect.poll(() => unassignedKpi(page)).toBe(0);
});

test('the strip comes back by itself when an unassigned item appears (poll/refocus)', async ({ page }) => {
  await page.goto('/issues');
  await expect(strip(page)).toHaveCount(0);
  const x = await newIssue(page.request, 'חוזר מהפולינג');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(card(page, x.id)).toBeVisible({ timeout: 20_000 });
  await expect(strip(page)).toBeVisible();
});

test('the board is a fixed 80vh; columns stretch to it and scroll inside, not the page', async ({ page }) => {
  // 14 open cards in one lane — far more than 80vh holds.
  for (let i = 0; i < 14; i += 1) {
    await newIssue(page.request, `גלילה ${i}`, { assignees: [{ assignee_type: 'user', id: adminId }] });
  }
  await page.goto('/issues');
  const adminLane = lane(page, `user:${adminId}`);
  await expect(adminLane).toBeVisible();

  const geo = await page.evaluate((key) => {
    const b = document.querySelector('[data-board-lanes]') as HTMLElement;
    const lanes = [...b.querySelectorAll<HTMLElement>('[data-lane]')];
    const mine = b.querySelector<HTMLElement>(`[data-lane="${key}"]`)!;
    const body = mine.querySelector<HTMLElement>('.wb-cbody')!;
    const bs = getComputedStyle(b);
    return {
      boardHeight: b.getBoundingClientRect().height,
      boardContent: b.clientHeight - parseFloat(bs.paddingBottom),
      vh: window.innerHeight,
      laneHeights: lanes.map((l) => Math.round(l.getBoundingClientRect().height)),
      laneInlineHeight: lanes.map((l) => l.style.height),
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyScrolls: body.scrollHeight > body.clientHeight,
      scrollbarWidth: getComputedStyle(body, '::-webkit-scrollbar').width,
      boardOverflowX: bs.overflowX,
      boardFlex: bs.flexGrow + ' ' + bs.flexShrink,
    };
  }, `user:${adminId}`);

  expect(Math.abs(geo.boardHeight - geo.vh * 0.8)).toBeLessThanOrEqual(1);
  expect(geo.boardFlex).toBe('0 0');
  expect(geo.boardOverflowX).toBe('auto');
  // Every column is as tall as the board's content box (align-items: stretch),
  // none carries a height of its own.
  for (const h of geo.laneHeights) expect(Math.abs(h - geo.boardContent)).toBeLessThanOrEqual(1);
  expect(geo.laneInlineHeight.every((h) => h === '')).toBe(true);
  expect(geo.bodyOverflowY).toBe('auto');
  expect(geo.bodyScrolls, 'the long column scrolls inside itself').toBe(true);
  expect(geo.scrollbarWidth).toBe('8px');
});

test('every column header has a 26×26 "+" to the right of the count, with its tooltip — empty columns too', async ({ page }) => {
  await page.goto('/issues');
  await expect(lane(page, `user:${secondId}`)).toBeVisible();
  for (const [key, label] of [
    [`user:${adminId}`, null],
    [`user:${secondId}`, SECOND_NAME],
    ['suppliers', 'ספקים'],
  ] as const) {
    const btn = addButton(page, key);
    await expect(btn).toBeVisible();
    if (label) await expect(btn).toHaveAttribute('title', `הוסף תקלה ל${label}`);
    const box = await btn.boundingBox();
    expect(Math.round(box!.width)).toBe(26);
    expect(Math.round(box!.height)).toBe(26);
    const countBox = await lane(page, key).locator('[data-lane-handle] span').last().boundingBox();
    const nameBox = await lane(page, key).locator('[data-lane-handle] h3').boundingBox();
    expect(box!.x, 'RTL: "+" sits to the right of the count').toBeGreaterThan(countBox!.x);
    expect(box!.x, '… and to the left of the name').toBeLessThan(nameBox!.x);
  }
  // a lane header drag must not start from the "+" button
  expect(await addButton(page, `user:${secondId}`).getAttribute('draggable')).toBe('false');
});

test('"+" on an employee column: the form opens with that employee locked; the issue is created in that column, no second notification', async ({ page }) => {
  await page.goto('/issues');
  await expect(addButton(page, `user:${secondId}`)).toBeVisible();
  await addButton(page, `user:${secondId}`).click();

  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'תקלה חדשה' })).toBeVisible();
  const title = `לשוניית פלוס`;
  await createdTitle(page, title);
  await expect(panel.getByText(SECOND_NAME).first()).toBeVisible();
  // both handler pickers are locked: the item must land in this one column
  await expect(panel.getByRole('button', { name: 'בחר עובד…' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /נבחר/ }).first()).toBeDisabled();
  await expect(panel.getByRole('button', { name: `הסר ${SECOND_NAME}` })).toHaveCount(0);

  const created = page.waitForResponse((r) => r.url().endsWith('/api/issues') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'צור תקלה' }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const id = ((await res.json()) as { issue: { id: string } }).issue.id;
  createdIssues.push(id);

  await expect(lane(page, `user:${secondId}`).locator(`[data-work-item-id="${id}"]`)).toBeVisible();
  await expect(strip(page).locator(`[data-work-item-id="${id}"]`)).toHaveCount(0);
  const got = (await readIssue(page.request, id)).issue;
  expect(got.assignee_user_id).toBe(secondId);
  expect(got.assignees).toHaveLength(1);
  const n = await pool.query(
    `select count(*)::int as n from public.notifications where source_entity_type = 'issue' and source_entity_id = $1 and user_id = $2`,
    [id, secondId],
  );
  expect(n.rows[0].n, 'only the creation notice, no extra assignment notice').toBeLessThanOrEqual(1);
});

test('the general "תקלה חדשה" form with ONE assignee lands in that column, not in the strip', async ({ page }) => {
  await page.goto('/issues');
  await page.getByRole('button', { name: 'תקלה חדשה' }).click();
  const panel = page.getByRole('dialog');
  await createdTitle(page, 'טופס כללי אחראי יחיד');
  await panel.getByRole('button', { name: 'בחר עובד…' }).click();
  await page.getByRole('checkbox', { name: SECOND_NAME }).click();
  await panel.getByRole('heading', { name: 'תקלה חדשה' }).click(); // close the picker popover

  const created = page.waitForResponse((r) => r.url().endsWith('/api/issues') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'צור תקלה' }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const id = ((await res.json()) as { issue: { id: string } }).issue.id;
  createdIssues.push(id);

  await expect(lane(page, `user:${secondId}`).locator(`[data-work-item-id="${id}"]`)).toBeVisible();
  await expect(strip(page).locator(`[data-work-item-id="${id}"]`)).toHaveCount(0);
  expect((await readIssue(page.request, id)).issue.assignee_user_id).toBe(secondId);
});

test('several assignees, or none, keep today’s behaviour: the item waits in "ממתינים לשיבוץ"', async ({ page }) => {
  const two = await newIssue(page.request, 'שני אחראים', {
    assignees: [{ assignee_type: 'user', id: adminId }, { assignee_type: 'user', id: secondId }],
  });
  const none = await newIssue(page.request, 'ללא אחראי');
  await page.goto('/issues');
  await expect(strip(page).locator(`[data-work-item-id="${two.id}"]`)).toBeVisible();
  await expect(strip(page).locator(`[data-work-item-id="${none.id}"]`)).toBeVisible();
  for (const id of [two.id, none.id]) {
    const got = (await readIssue(page.request, id)).issue;
    expect(got.assignee_user_id).toBeNull();
    expect(got.assignee_supplier_id).toBeNull();
  }
});

test('a single SUPPLIER assignee lands in the suppliers column; its "+" locks only the employee picker', async ({ page }) => {
  const viaApi = await newIssue(page.request, 'ספק יחיד', { assignees: [{ assignee_type: 'supplier', id: supplierId }] });
  await page.goto('/issues');
  await expect(lane(page, 'suppliers').locator(`[data-work-item-id="${viaApi.id}"]`)).toBeVisible();
  expect((await readIssue(page.request, viaApi.id)).issue.assignee_supplier_id).toBe(supplierId);

  await addButton(page, 'suppliers').click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'תקלה חדשה' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'בחר עובד…' })).toBeDisabled();
  const supplierPicker = panel.getByRole('button', { name: 'בחר ספק…' });
  await expect(supplierPicker).toBeEnabled();
  // The side panel is still sliding in right after it renders; a click that
  // lands mid-animation can open and drop the popover again — retry the open.
  const option = page.getByRole('checkbox', { name: SUPPLIER_NAME });
  await expect(async () => {
    if (!(await option.isVisible())) await supplierPicker.click();
    await expect(option).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  await option.click();
  await panel.getByRole('heading', { name: 'תקלה חדשה' }).click();
  await createdTitle(page, 'מלשונית ספקים');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/issues') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'צור תקלה' }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const id = ((await res.json()) as { issue: { id: string } }).issue.id;
  createdIssues.push(id);
  await expect(lane(page, 'suppliers').locator(`[data-work-item-id="${id}"]`)).toBeVisible();
});

test('/tasks: same board — "הוסף משימה ל…" tooltip, and a one-assignee task is created in the column', async ({ page }) => {
  await page.goto('/tasks');
  await expect(addButton(page, `user:${secondId}`)).toHaveAttribute('title', `הוסף משימה ל${SECOND_NAME}`);

  const res = await page.request.post('/api/tasks', {
    data: { title: `E2E ${uniq} · משימה`, priority: 'normal', assignees: [{ assignee_type: 'user', id: secondId }] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const task = ((await res.json()) as { task: { id: string } }).task;
  createdTasks.push(task.id);
  await page.reload();
  await expect(lane(page, `user:${secondId}`).locator(`[data-work-item-id="${task.id}"]`)).toBeVisible();
  await expect(strip(page).locator(`[data-work-item-id="${task.id}"]`)).toHaveCount(0);

  await addButton(page, `user:${secondId}`).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'משימה חדשה' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText(SECOND_NAME).first()).toBeVisible();
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('no board under lg — the list shows and the page does not scroll sideways', async ({ page }) => {
    await page.goto('/issues');
    await expect(page.getByRole('heading', { name: 'תקלות' })).toBeVisible();
    await expect(board(page)).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
