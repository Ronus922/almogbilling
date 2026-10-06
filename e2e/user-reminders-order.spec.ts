import { test, expect, devices, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { loginThroughForm } from './helpers';

// The per-user order of the reminders list (06/10/2026), in a real browser,
// with two people on the same reminders: the seeded e2e-admin (their creator)
// and a manager this file creates (user B, assigned to two of them).
//   • a card dragged above another stays there — after a reload, and for the
//     admin alone: B's "משותף איתי" keeps its order;
//   • B's own drag moves B's list alone and survives a reload AND a new login;
//   • a new reminder lands at the end, whatever its time; a drop at the
//     bottom puts the card under the last one;
//   • the order endpoint refuses a reminder that is not the caller's;
//   • a finger: long press on a phone reorders too (CDP touch events).
// Mouse drags use Playwright's dragTo on the native HTML5 drag; the drop lands
// above the card under the pointer, so the target is that card's top edge.
// Every row this file creates is removed by its exact id (iron rule 12) —
// the order rows go with their reminders (ON DELETE CASCADE).

test.describe.configure({ mode: 'serial' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `e2e-rord-${Date.now()}`;
const NAME = `משתמש ב׳ ${uniq}`;
const EMAIL = `${uniq}@billing.local`;
const PASSWORD = 'E2e-Temp0rary!';

let adminId = '';
let userBId = '';
const ids = { r1: '', r2: '', r3: '', r4: '' };
let bCtx: BrowserContext | null = null;
let bPage: Page | null = null;

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const mine = () => Object.values(ids).filter(Boolean);

test.afterAll(async () => {
  await bCtx?.close();
  const reminderIds = mine();
  if (reminderIds.length) {
    const audit = await pool.query<{ id: string }>(
      `select id from public.audit_log where entity_type = 'reminder' and entity_id = any($1::text[])`, [reminderIds],
    );
    for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
    for (const id of reminderIds) await pool.query(`delete from public.user_reminders where id = $1`, [id]);
  }
  if (userBId) {
    const audit = await pool.query<{ id: string }>(
      `select id from public.audit_log where entity_type = 'user' and entity_id = $1`, [userBId],
    );
    for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
    await pool.query(`delete from public.users where id = $1`, [userBId]);
  }
  await pool.end();
});

const card = (page: Page, id: string) => page.locator(`[data-reminder-id="${id}"]`);

/** This file's cards on the page, top to bottom. */
async function order(page: Page): Promise<string[]> {
  const all = await page.locator('[data-reminder-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-reminder-id') ?? ''));
  return all.filter((id) => mine().includes(id));
}

/** What the database holds for `userId`, by position. */
async function stored(userId: string): Promise<Array<[string, number]>> {
  const r = await pool.query<{ reminder_id: string; position: number }>(
    `select reminder_id, position from public.user_reminder_order
      where user_id = $1 and reminder_id = any($2::uuid[]) order by position`,
    [userId, mine()],
  );
  return r.rows.map((x) => [x.reminder_id, x.position]);
}

const orderWrite = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/api/user-reminders/order'));

/** Drag `id` and drop it right above `aboveId`; the server's answer is 200,
 *  and the body it got is returned. A drag never opens the panel. */
async function dragAbove(page: Page, id: string, aboveId: string): Promise<string[]> {
  const write = orderWrite(page);
  await card(page, id).dragTo(card(page, aboveId), { targetPosition: { x: 60, y: 4 } });
  const res = await write;
  expect(res.status(), await res.text()).toBe(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return (res.request().postDataJSON() as { ids: string[] }).ids;
}

/** Drag `id` onto the lower half of the last card: under it. */
async function dragToBottom(page: Page, id: string): Promise<string[]> {
  const write = orderWrite(page);
  const last = page.locator('[data-reminder-id]').last();
  const box = await last.boundingBox();
  if (!box) throw new Error('no last card on screen');
  await card(page, id).dragTo(last, { targetPosition: { x: 60, y: box.height - 4 } });
  const res = await write;
  expect(res.status(), await res.text()).toBe(200);
  return (res.request().postDataJSON() as { ids: string[] }).ids;
}

async function openMine(page: Page) {
  await page.goto('/user-reminders');
  await page.getByRole('button', { name: /^שלי/ }).click();
  await expect(card(page, ids.r1)).toBeVisible();
}
async function openShared(page: Page) {
  await page.goto('/user-reminders');
  await page.getByRole('button', { name: /משותף איתי/ }).click();
  await expect(card(page, ids.r2)).toBeVisible();
}

test.describe('the reminders list — each user\'s own order', () => {
  test.use({ viewport: { width: 1400, height: 1600 } });

  test('the admin makes three reminders, two of them B\'s; both lists start by time', async ({ page, browser }) => {
    const me = (await (await page.request.get('/api/auth/me')).json()) as { user: { id: string; role: string } };
    expect(me.user.role).toBe('super_admin');
    adminId = me.user.id;

    const created = await page.request.post('/api/users', { data: { email: EMAIL, full_name: NAME, role: 'manager', password: PASSWORD } });
    expect(created.status(), await created.text()).toBe(201);
    userBId = ((await created.json()) as { id: string }).id;

    const make = async (title: string, hours: number, assigned: boolean) => {
      const res = await page.request.post('/api/user-reminders', {
        data: { title: `${uniq} ${title}`, remind_at: inHours(hours), assigned_to: assigned ? userBId : null },
      });
      expect(res.status(), await res.text()).toBe(201);
      return ((await res.json()) as { reminder: { id: string } }).reminder.id;
    };
    ids.r1 = await make('ראשונה', 1, false);
    ids.r2 = await make('שנייה', 2, true);
    ids.r3 = await make('שלישית', 3, true);

    const login = await loginThroughForm(browser, EMAIL, PASSWORD);
    expect(login.ok, 'user B logs in').toBe(true);
    bCtx = login.ctx;
    bPage = login.page;

    await openMine(page);
    expect(await order(page)).toEqual([ids.r1, ids.r2, ids.r3]);
    await openShared(bPage);
    expect(await order(bPage)).toEqual([ids.r2, ids.r3]);
  });

  test('the admin drags the third above the first: it stays after a reload, and B\'s list does not move', async ({ page }) => {
    await openMine(page);
    expect(await dragAbove(page, ids.r3, ids.r1)).toEqual([ids.r3, ids.r1, ids.r2]);
    expect(await order(page)).toEqual([ids.r3, ids.r1, ids.r2]);
    await openMine(page);
    expect(await order(page)).toEqual([ids.r3, ids.r1, ids.r2]);
    expect(await stored(adminId)).toEqual([[ids.r3, 0], [ids.r1, 1], [ids.r2, 2]]);
    expect(await stored(userBId)).toEqual([]);

    await openShared(bPage!);
    expect(await order(bPage!)).toEqual([ids.r2, ids.r3]);
  });

  test('B drags the third above the second: B\'s rows alone, kept after a reload and a new login; the admin\'s list stays', async ({ page, browser }) => {
    expect(await dragAbove(bPage!, ids.r3, ids.r2)).toEqual([ids.r3, ids.r2]);
    expect(await order(bPage!)).toEqual([ids.r3, ids.r2]);
    await openShared(bPage!);
    expect(await order(bPage!)).toEqual([ids.r3, ids.r2]);
    expect(await stored(userBId)).toEqual([[ids.r3, 0], [ids.r2, 1]]);
    expect(await stored(adminId)).toEqual([[ids.r3, 0], [ids.r1, 1], [ids.r2, 2]]);

    await openMine(page);
    expect(await order(page)).toEqual([ids.r3, ids.r1, ids.r2]);

    // A new session of B sees the same order.
    await bPage!.request.post('/api/auth/logout');
    await bCtx!.close();
    const again = await loginThroughForm(browser, EMAIL, PASSWORD);
    expect(again.ok, 'user B logs in again').toBe(true);
    bCtx = again.ctx;
    bPage = again.page;
    await openShared(bPage);
    expect(await order(bPage)).toEqual([ids.r3, ids.r2]);
  });

  test('a new reminder lands at the end whatever its time; a drop at the bottom goes under the last card', async ({ page }) => {
    const res = await page.request.post('/api/user-reminders', { data: { title: `${uniq} רביעית`, remind_at: inHours(0.5) } });
    expect(res.status(), await res.text()).toBe(201);
    ids.r4 = ((await res.json()) as { reminder: { id: string } }).reminder.id;

    await openMine(page);
    expect(await order(page)).toEqual([ids.r3, ids.r1, ids.r2, ids.r4]);
    expect(await dragToBottom(page, ids.r3)).toEqual([ids.r1, ids.r2, ids.r4, ids.r3]);
    expect(await order(page)).toEqual([ids.r1, ids.r2, ids.r4, ids.r3]);
    await openMine(page);
    expect(await order(page)).toEqual([ids.r1, ids.r2, ids.r4, ids.r3]);
  });

  test('the order endpoint refuses what is not the caller\'s, and writes nothing then', async () => {
    const put = (list: string[]) => bPage!.request.put('/api/user-reminders/order', { data: { ids: list } });
    expect((await put([ids.r1])).status()).toBe(403);
    expect((await put([ids.r2, ids.r1])).status()).toBe(403);
    expect((await put([ids.r2, '00000000-0000-4000-8000-00000000dead'])).status()).toBe(404);
    expect((await put([ids.r2, ids.r2])).status()).toBe(400);
    expect(await stored(userBId)).toEqual([[ids.r3, 0], [ids.r2, 1]]);
  });
});

test.describe('a finger on a phone', () => {
  const phone = (() => {
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13'];
    return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
  })();

  interface Pt { x: number; y: number }

  async function centre(page: Page, id: string): Promise<Pt> {
    await card(page, id).scrollIntoViewIfNeeded();
    const b = await card(page, id).boundingBox();
    if (!b) throw new Error(`card ${id} is not on screen`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function topEdge(page: Page, id: string): Promise<Pt> {
    const b = await card(page, id).boundingBox();
    if (!b) throw new Error(`card ${id} is not on screen`);
    return { x: b.x + b.width / 2, y: b.y + 4 };
  }
  /** Long press (700ms > the 500ms hold) on `from`, slide to `to`, lift. */
  async function longPressDrag(page: Page, from: Pt, to: Pt): Promise<string[]> {
    const write = orderWrite(page);
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
    const res = await write;
    expect(res.status(), await res.text()).toBe(200);
    return (res.request().postDataJSON() as { ids: string[] }).ids;
  }

  test('B long-presses the second and lifts it above the third', async ({ browser }) => {
    // B's session, carried into a phone context — no further login.
    const state = await bCtx!.storageState();
    const ctx = await browser.newContext({ ...phone, storageState: state });
    const page = await ctx.newPage();
    try {
      await openShared(page);
      expect(await order(page)).toEqual([ids.r3, ids.r2]);
      expect(await longPressDrag(page, await centre(page, ids.r2), await topEdge(page, ids.r3))).toEqual([ids.r2, ids.r3]);
      expect(await order(page)).toEqual([ids.r2, ids.r3]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await openShared(page);
      expect(await order(page)).toEqual([ids.r2, ids.r3]);
      expect(await stored(userBId)).toEqual([[ids.r2, 0], [ids.r3, 1]]);
    } finally {
      await ctx.close();
    }
  });
});
