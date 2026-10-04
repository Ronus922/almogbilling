import { test, expect, devices, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

// Touch on the manual issues kanban (04/10/2026). A finger gets no HTML5 drag,
// so the board drags by LONG PRESS (~500ms); the mouse specs
// (issues-kanban-dnd.spec.ts) are untouched.
//   • tablet (iPad, 810px wide): long press + drag into another column, between
//     two cards → it lands there and stays after a reload; a short tap opens
//     the issue; a scroll that starts on a card scrolls and moves nothing;
//   • phone (iPhone, 390px): long press reorders inside the column; "העבר אל…"
//     moves a card to the TOP of the chosen column and stays after a reload;
//     "בוצע" in that menu closes the issue; the menu never opens the panel.
// Real touch events through CDP (Input.dispatchTouchEvent /
// synthesizeScrollGesture) — Chromium only, like the whole suite.
//
// Every issue this file creates is recorded by id at creation and removed by
// that id — with its handler rows and bells (iron rule 12).

const deviceOf = (name: string) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices[name];
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
};

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
interface Pt { x: number; y: number }
interface IssueRow {
  id: string;
  status: string;
  due_date: string | null;
  board_column: string | null;
  assignees: { user_id: string | null }[];
}

async function newIssue(request: APIRequestContext, title: string, opts: { handled?: boolean; due?: string } = {}) {
  const res = await request.post('/api/issues', {
    data: {
      title: `E2E מגע · ${title}`,
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

async function order(page: Page, column: Column, mine: string[]): Promise<string[]> {
  const ids = await page.locator(`[data-column="${column}"] [data-issue-id]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-issue-id') ?? ''));
  return ids.filter((id) => mine.includes(id));
}

/** The middle of a card, scrolled into view first. */
async function centre(page: Page, id: string): Promise<Pt> {
  await card(page, id).scrollIntoViewIfNeeded();
  const b = await card(page, id).boundingBox();
  if (!b) throw new Error(`card ${id} is not on screen`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The top edge of a card — a drop there lands right above it. */
async function topEdge(page: Page, id: string): Promise<Pt> {
  const b = await card(page, id).boundingBox();
  if (!b) throw new Error(`card ${id} is not on screen`);
  return { x: b.x + b.width / 2, y: b.y + 4 };
}

/** Long press (700ms > the 500ms hold) on `from`, slide to `to`, lift —
 *  waiting for the server's answer to the drop. */
async function longPressDrag(page: Page, from: Pt, to: Pt) {
  const write = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/move'));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: Pt) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
  await touch('touchStart', from);
  await page.waitForTimeout(700);
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  await touch('touchEnd');
  await cdp.detach();
  expect((await write).status()).toBe(200);
}

const panel = (page: Page) => page.getByRole('heading', { name: 'עריכת תקלה' });

async function openBoard(page: Page, firstCard: string) {
  await page.goto('/issues');
  await expect(card(page, firstCard)).toBeVisible();
}

test.describe('tablet (iPad) — long press drags across columns', () => {
  test.use(deviceOf('iPad (gen 7)'));

  test('long press + drag into another column, between two cards → lands there, and stays after a reload', async ({ page }) => {
    const t1 = await newIssue(page.request, 'היום 1', { handled: true, due: TODAY });
    const t2 = await newIssue(page.request, 'היום 2', { handled: true, due: TODAY });
    const m = await newIssue(page.request, 'נגרר');
    const mine = [t1.id, t2.id, m.id];
    await openBoard(page, m.id);
    // 810px: two columns a row, the "העבר אל…" button is a phone thing.
    await expect(card(page, m.id).getByRole('button', { name: 'העבר אל…' })).toBeHidden();
    expect(await order(page, 'today', mine)).toEqual([t2.id, t1.id]);

    await longPressDrag(page, await centre(page, m.id), await topEdge(page, t1.id));
    await expect.poll(() => order(page, 'today', mine)).toEqual([t2.id, m.id, t1.id]);
    await expect(panel(page)).toBeHidden();

    await page.reload();
    await expect(card(page, m.id)).toBeVisible();
    expect(await order(page, 'today', mine)).toEqual([t2.id, m.id, t1.id]);
    expect(await order(page, 'awaiting', mine)).toEqual([]);
    const moved = await readIssue(page.request, m.id);
    expect(moved).toMatchObject({ board_column: 'today', due_date: null, status: 'open' });
    expect(moved.assignees).toEqual([]);
  });

  test('a short tap opens the issue', async ({ page }) => {
    const c = await newIssue(page.request, 'הקשה', { handled: true });
    await openBoard(page, c.id);
    await card(page, c.id).tap(); // scrolls it into view, then a real tap in the middle
    await expect(panel(page)).toBeVisible();
  });

  test('a scroll that starts on a card scrolls the page and moves nothing', async ({ page }) => {
    const a = await newIssue(page.request, 'גלילה א', { handled: true });
    const b = await newIssue(page.request, 'גלילה ב', { handled: true });
    const mine = [a.id, b.id];
    await openBoard(page, a.id);
    const moves: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH') moves.push(r.url()); });
    const scroller = page.locator('main');
    const before = await scroller.evaluate((el) => el.scrollTop);
    const p = await centre(page, b.id);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(p.x), y: Math.round(p.y), yDistance: -300, gestureSourceType: 'touch', speed: 1200,
    });
    await cdp.detach();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
    await page.waitForTimeout(800); // longer than the hold — nothing may start late
    expect(moves).toEqual([]);
    expect(await order(page, 'in_progress', mine)).toEqual([b.id, a.id]);
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('phone (iPhone) — long press reorders, "העבר אל…" moves', () => {
  test.use(deviceOf('iPhone 13'));

  test('long press reorders inside the column, and it stays after a reload', async ({ page }) => {
    const p1 = await newIssue(page.request, 'סידור 1', { handled: true });
    const p2 = await newIssue(page.request, 'סידור 2', { handled: true });
    const p3 = await newIssue(page.request, 'סידור 3', { handled: true });
    const mine = [p1.id, p2.id, p3.id];
    await openBoard(page, p3.id);
    await card(page, p3.id).scrollIntoViewIfNeeded();
    expect(await order(page, 'in_progress', mine)).toEqual([p3.id, p2.id, p1.id]);

    await longPressDrag(page, await centre(page, p1.id), await topEdge(page, p3.id));
    await expect.poll(() => order(page, 'in_progress', mine)).toEqual([p1.id, p3.id, p2.id]);
    await expect(panel(page)).toBeHidden();

    await page.reload();
    await expect(card(page, p1.id)).toBeAttached();
    expect(await order(page, 'in_progress', mine)).toEqual([p1.id, p3.id, p2.id]);
  });

  test('"העבר אל…" → the top of the chosen column, without opening the issue — and it stays after a reload', async ({ page }) => {
    const x = await newIssue(page.request, 'העברה', { handled: true });
    await openBoard(page, x.id);
    const write = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/move'));
    await card(page, x.id).getByRole('button', { name: 'העבר אל…' }).tap();
    const menu = page.locator('[data-slot="popover-content"]');
    await expect(menu.getByRole('button')).toHaveText(['ממתין לשיוך', 'לטיפול היום', 'בוצע']);
    await menu.getByRole('button', { name: 'ממתין לשיוך' }).tap();
    expect((await write).status()).toBe(200);
    await expect(panel(page)).toBeHidden();
    await expect.poll(async () => (await page.locator('[data-column="awaiting"] [data-issue-id]').first().getAttribute('data-issue-id')))
      .toBe(x.id);

    await page.reload();
    await expect(card(page, x.id)).toBeAttached();
    expect(await page.locator('[data-column="awaiting"] [data-issue-id]').first().getAttribute('data-issue-id')).toBe(x.id);
    const moved = await readIssue(page.request, x.id);
    expect(moved).toMatchObject({ board_column: 'awaiting', status: 'open' });
    expect(moved.assignees.map((a) => a.user_id)).toEqual([adminId]);
  });

  test('"בוצע" in "העבר אל…" closes the issue, like a drop on it', async ({ page }) => {
    const y = await newIssue(page.request, 'סגירה', { handled: true });
    await openBoard(page, y.id);
    const write = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/issues/${y.id}`));
    await card(page, y.id).getByRole('button', { name: 'העבר אל…' }).tap();
    await page.locator('[data-slot="popover-content"]').getByRole('button', { name: 'בוצע' }).tap();
    expect((await write).status()).toBe(200);
    await expect(card(page, y.id)).toHaveCount(0);
    await expect(panel(page)).toBeHidden();
    expect((await readIssue(page.request, y.id)).status).toBe('closed');
  });
});
