import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

// The issues kanban as a MANUAL board (Ronen, 04/10/2026), in a real browser:
//   • a card dragged up or down its own column stays where it was dropped;
//   • a card dragged into ממתין לשיוך / לטיפול היום / בטיפול lands between the
//     two cards it was dropped between — and its handlers, date and priority
//     do not change;
//   • both survive a reload (board_column + sort_order in the database);
//   • a drag never opens the issue panel, a click does;
//   • a drop on "בוצע" still closes the issue.
// Native HTML5 drag and drop, driven by Playwright's dragTo: the drop lands
// above the card under the pointer, so the target position is the top edge of
// the card it should land above.
//
// Every issue this file creates is recorded by id at creation and removed by
// that id — with its handler rows and bells (iron rule 12).

test.use({ viewport: { width: 1600, height: 1800 } });
test.describe.configure({ mode: 'serial' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);
const created: string[] = [];
let adminId = '';

test.beforeAll(async () => {
  const r = await pool.query<{ id: string }>(`select id from public.users where username = 'e2e-admin'`);
  adminId = r.rows[0]?.id ?? '';
  expect(adminId, 'seeded e2e-admin').not.toBe('');
});

test.afterAll(async () => {
  for (const id of created) {
    await pool.query(`delete from public.notifications where source_entity_type = 'issue' and source_entity_id = $1`, [id]);
    await pool.query(`delete from public.entity_assignees where entity_type = 'issue' and entity_id = $1`, [id]);
    await pool.query(`delete from public.issues where id = $1`, [id]);
  }
  await pool.end();
});

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

type Column = 'awaiting' | 'today' | 'in_progress' | 'done';

interface IssueRow {
  id: string;
  status: string;
  priority: string;
  due_date: string | null;
  board_column: string | null;
  assignees: { user_id: string | null }[];
}

/** A staff issue through the real route; it opens at the top of its column. */
async function newIssue(request: APIRequestContext, title: string, opts: { handled?: boolean; due?: string } = {}) {
  const res = await request.post('/api/issues', {
    data: {
      title: `E2E קנבן · ${title}`,
      priority: 'normal',
      due_date: opts.due ?? null,
      assignees: opts.handled ? [{ assignee_type: 'user', id: adminId }] : [],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { issue } = (await res.json()) as { issue: IssueRow };
  created.push(issue.id);
  return issue;
}

async function readIssue(request: APIRequestContext, id: string): Promise<IssueRow> {
  const res = await request.get(`/api/issues/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { issue: IssueRow }).issue;
}

const card = (page: Page, id: string) => page.locator(`[data-issue-id="${id}"]`);

/** This file's cards in a column, top to bottom, as the page shows them. */
async function order(page: Page, column: Column, mine: string[]): Promise<string[]> {
  const ids = await page.locator(`[data-column="${column}"] [data-issue-id]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-issue-id') ?? ''));
  return ids.filter((id) => mine.includes(id));
}

/** Drag `id` and drop it right above `aboveId` (or onto an empty spot of the
 *  column), waiting for the server's answer. */
async function dragAbove(page: Page, id: string, target: { aboveId: string } | { column: Column }) {
  const write = page.waitForResponse((r) =>
    r.request().method() === 'PATCH' && /\/api\/issues\/[0-9a-f-]{36}(\/move)?$/.test(r.url()));
  if ('aboveId' in target) {
    await card(page, id).dragTo(card(page, target.aboveId), { targetPosition: { x: 60, y: 4 } });
  } else {
    // The column's bottom edge — below every card.
    const column = page.locator(`[data-column="${target.column}"]`);
    const box = await column.boundingBox();
    if (!box) throw new Error(`column ${target.column} is not on screen`);
    await card(page, id).dragTo(column, { targetPosition: { x: 60, y: box.height - 6 } });
  }
  expect((await write).status()).toBe(200);
  // A drag is never a click: the panel stays closed.
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openBoard(page: Page, firstCard: string) {
  await page.goto('/issues');
  await expect(card(page, firstCard)).toBeVisible();
}

test('a card dragged up its own column stays there — after a reload too', async ({ page }) => {
  const r1 = await newIssue(page.request, 'סידור 1', { handled: true });
  const r2 = await newIssue(page.request, 'סידור 2', { handled: true });
  const r3 = await newIssue(page.request, 'סידור 3', { handled: true });
  const mine = [r1.id, r2.id, r3.id];
  await openBoard(page, r1.id);
  // Newest on top: a new issue opens at the top of its column.
  expect(await order(page, 'in_progress', mine)).toEqual([r3.id, r2.id, r1.id]);

  await dragAbove(page, r1.id, { aboveId: r3.id });
  await expect.poll(() => order(page, 'in_progress', mine)).toEqual([r1.id, r3.id, r2.id]);

  await dragAbove(page, r3.id, { column: 'in_progress' }); // an empty spot under the cards = the bottom
  await expect.poll(() => order(page, 'in_progress', mine)).toEqual([r1.id, r2.id, r3.id]);

  await page.reload();
  await expect(card(page, r1.id)).toBeVisible();
  expect(await order(page, 'in_progress', mine)).toEqual([r1.id, r2.id, r3.id]);
});

test('into each column, between two cards — it lands there, keeps its handler, date and priority, and stays after a reload', async ({ page }) => {
  const aw1 = await newIssue(page.request, 'ממתין 1');
  const aw2 = await newIssue(page.request, 'ממתין 2');
  const td1 = await newIssue(page.request, 'היום 1', { handled: true, due: TODAY });
  const td2 = await newIssue(page.request, 'היום 2', { handled: true, due: TODAY });
  const ip1 = await newIssue(page.request, 'בטיפול 1', { handled: true });
  const ip2 = await newIssue(page.request, 'בטיפול 2', { handled: true });
  const toAwaiting = await newIssue(page.request, 'אל ממתין', { handled: true });
  const toToday = await newIssue(page.request, 'אל היום');
  const toProgress = await newIssue(page.request, 'אל בטיפול', { handled: true, due: TODAY });
  const mine = [aw1, aw2, td1, td2, ip1, ip2, toAwaiting, toToday, toProgress].map((i) => i.id);

  await openBoard(page, aw1.id);
  expect(await order(page, 'awaiting', mine)).toEqual([toToday.id, aw2.id, aw1.id]);
  expect(await order(page, 'today', mine)).toEqual([toProgress.id, td2.id, td1.id]);
  expect(await order(page, 'in_progress', mine)).toEqual([toAwaiting.id, ip2.id, ip1.id]);

  await dragAbove(page, toAwaiting.id, { aboveId: aw1.id });
  await expect.poll(() => order(page, 'awaiting', mine)).toEqual([toToday.id, aw2.id, toAwaiting.id, aw1.id]);

  await dragAbove(page, toToday.id, { aboveId: td1.id });
  await expect.poll(() => order(page, 'today', mine)).toEqual([toProgress.id, td2.id, toToday.id, td1.id]);

  await dragAbove(page, toProgress.id, { aboveId: ip1.id });
  await expect.poll(() => order(page, 'in_progress', mine)).toEqual([ip2.id, toProgress.id, ip1.id]);

  await page.reload();
  await expect(card(page, aw1.id)).toBeVisible();
  expect(await order(page, 'awaiting', mine)).toEqual([aw2.id, toAwaiting.id, aw1.id]);
  expect(await order(page, 'today', mine)).toEqual([td2.id, toToday.id, td1.id]);
  expect(await order(page, 'in_progress', mine)).toEqual([ip2.id, toProgress.id, ip1.id]);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Only the place changed — handlers, date, priority and status as they were.
  const a = await readIssue(page.request, toAwaiting.id);
  expect(a).toMatchObject({ board_column: 'awaiting', due_date: null, priority: 'normal', status: 'open' });
  expect(a.assignees.map((x) => x.user_id)).toEqual([adminId]);
  const t = await readIssue(page.request, toToday.id);
  expect(t).toMatchObject({ board_column: 'today', due_date: null, priority: 'normal', status: 'open' });
  expect(t.assignees).toEqual([]);
  const p = await readIssue(page.request, toProgress.id);
  expect(p).toMatchObject({ board_column: 'in_progress', due_date: TODAY, priority: 'normal', status: 'open' });
  expect(p.assignees.map((x) => x.user_id)).toEqual([adminId]);
});

test('a drop on בוצע closes the issue — it moves to the "הושלמו" tab', async ({ page }) => {
  const x = await newIssue(page.request, 'לסגירה', { handled: true });
  await openBoard(page, x.id);
  await dragAbove(page, x.id, { column: 'done' });
  await expect(card(page, x.id)).toHaveCount(0);
  expect((await readIssue(page.request, x.id)).status).toBe('closed');
  await page.getByRole('button', { name: /^הושלמו/ }).click();
  // The table row (the phone-only list under it is display:none on desktop).
  await expect(page.getByRole('row', { name: /E2E קנבן · לסגירה.*סגורה/ })).toBeVisible();
});

test('a click opens the issue panel', async ({ page }) => {
  const c = await newIssue(page.request, 'לחיצה', { handled: true });
  await openBoard(page, c.id);
  await card(page, c.id).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'עריכת תקלה' })).toBeVisible();
});
