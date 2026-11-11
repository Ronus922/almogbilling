import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';

// The navigation rail + panel (11/11/2026, DESIGN.md §14): a dark strip of category buttons and
// a white panel listing the items of ONE category. Pinned here, on the production build:
//   · a click on a category only switches the panel — the URL does not move, nothing is marked;
//   · a click on an item navigates and marks it, and its category is marked in the rail;
//   · the shown category's button again closes the panel (any button opens a closed one), the
//     choice survives a reload, and the panel PUSHES the content;
//   · who sees which categories (guard / viewer / admin) — the same set the old single list showed;
//   · the phone drawer: the same rail + panel, 44px items, an item navigates and closes it;
//   · a short window (1366×620): settings and logout stay on screen and reachable.
//
// Users made here get a session row straight in the DB (the cookie holds the raw token, the table
// its SHA-256) — a form login for each would eat the 20-per-15-minutes budget the whole e2e job
// shares. Fixtures are removed by the exact ids recorded here (CLAUDE.md iron rule 12).

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const RUN = Date.now().toString(36);
const PASSWORD = 'E2e-Nav-Pass1!';
const STORAGE_KEY = 'almog:sidebar-collapsed';

const userIds: string[] = [];
const contexts: BrowserContext[] = [];
const people: Record<'guard' | 'viewer' | 'admin', { id: string }> = {} as never;

async function userId(where: 'username' | 'email', value: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from public.users where ${where} = $1`, [value]);
  expect(r.rows, `user ${value}`).toHaveLength(1);
  return r.rows[0]!.id;
}

async function sessionFor(browser: Browser, uid: string, viewport?: { width: number; height: number }): Promise<Page> {
  const raw = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into public.sessions (id, user_id, expires_at, remember) values ($1, $2, now() + interval '3 hours', false)`,
    [createHash('sha256').update(raw).digest('hex'), uid],
  );
  const ctx = await browser.newContext({
    viewport,
    storageState: { cookies: [{ name: 'almog_sid', value: raw, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] },
  });
  contexts.push(ctx);
  return ctx.newPage();
}

const rail = (page: Page) => page.locator('aside nav[aria-label="קטגוריות ניווט"]');
const railButtons = (page: Page) => rail(page).locator('button[data-nav-category]');
const railButton = (page: Page, label: string) => rail(page).locator('button[data-nav-category]', { hasText: new RegExp(`^${label}$`) });
const panel = (page: Page) => page.locator('aside [data-nav-panel]');
const panelItems = (panelRoot: Locator) => panelRoot.locator('a[data-nav-item]');
const railLabels = async (page: Page) => (await railButtons(page).allInnerTexts()).map((t) => t.trim());

test.beforeAll(async ({ request }) => {
  const make = async (data: Record<string, string>) => {
    const r = await request.post('/api/users', { data });
    expect(r.status(), await r.text()).toBe(201);
  };
  const guard = `navgate-${RUN}`;
  await make({ role: 'guard', username: guard, full_name: `שומר ניווט ${RUN}`, password: PASSWORD });
  people.guard = { id: await userId('username', guard) };
  const viewer = `nav-viewer-${RUN}@billing.local`;
  await make({ role: 'viewer', email: viewer, full_name: `צופה ניווט ${RUN}`, password: PASSWORD });
  people.viewer = { id: await userId('email', viewer) };
  const admin = `nav-admin-${RUN}@billing.local`;
  await make({ role: 'admin', email: admin, full_name: `אדמין ניווט ${RUN}`, password: PASSWORD });
  people.admin = { id: await userId('email', admin) };
  userIds.push(people.guard.id, people.viewer.id, people.admin.id);
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  await pool.query(`delete from public.audit_log where entity_id = any($1::text[]) or actor_user_id = any($1::uuid[])`, [userIds]);
  await pool.query(`delete from public.users where id = any($1::uuid[])`, [userIds]);
  await pool.end();
});

test('a click on a category switches the panel — the URL does not move and nothing is marked', async ({ page }) => {
  await page.goto('/dashboard');
  // The panel opens on the page's own category, with the page's own item marked.
  await expect(panel(page)).toHaveAttribute('data-nav-panel', 'finance');
  await expect(panel(page)).toHaveAttribute('data-state', 'open');
  await expect(panel(page).locator('a[aria-current="page"]')).toHaveText('ניהול חיובים');
  await expect(railButton(page, 'כספים')).toHaveAttribute('aria-expanded', 'true');
  await expect(railButton(page, 'כספים')).toHaveAttribute('data-selected', 'true');

  await railButton(page, 'תפעול').click();
  await expect(panel(page)).toHaveAttribute('data-nav-panel', 'ops');
  await expect(panel(page).getByText('תפעול ואחזקה', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('תקלות, משימות ולו"ז')).toBeVisible();
  expect(await panelItems(panel(page)).allInnerTexts()).toEqual(['תקלות', 'משימות', 'תזכורות', 'יומן', 'ניהול אזורים']);
  expect(new URL(page.url()).pathname).toBe('/dashboard');
  // This category does not hold the current page: no item is marked, the rail marks what is shown.
  await expect(panel(page).locator('[aria-current]')).toHaveCount(0);
  await expect(railButton(page, 'תפעול')).toHaveAttribute('data-selected', 'true');
  await expect(railButton(page, 'כספים')).not.toHaveAttribute('data-selected', 'true');
  await expect(railButton(page, 'תפעול')).toHaveAttribute('aria-expanded', 'true');
  await expect(railButton(page, 'כספים')).toHaveAttribute('aria-expanded', 'false');
});

test('a click on an item navigates, marks it, and marks its category in the rail', async ({ page }) => {
  await page.goto('/dashboard');
  await railButton(page, 'תפעול').click();
  await panel(page).locator('a[data-nav-item="/issues"]').click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(panel(page)).toHaveAttribute('data-nav-panel', 'ops');
  await expect(panel(page)).toHaveAttribute('data-state', 'open'); // navigating leaves the panel open
  await expect(panel(page).locator('a[aria-current="page"]')).toHaveText('תקלות');
  await expect(panel(page).locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(railButton(page, 'תפעול')).toHaveAttribute('data-selected', 'true');
  await expect(rail(page).locator('[data-selected="true"]')).toHaveCount(1);
});

test('a first load on a page in no category shows the first permitted one, nothing marked in the panel', async ({ page }) => {
  await page.goto('/notifications');
  await expect(panel(page)).toHaveAttribute('data-nav-panel', 'home');
  await expect(panel(page).locator('[aria-current]')).toHaveCount(0);
});

test('the same button again closes the panel, any button opens it, the choice survives a reload, and the panel pushes the content', async ({ page }) => {
  await page.goto('/issues');
  const aside = page.locator('aside').first();
  const main = page.locator('main');
  const viewportWidth = page.viewportSize()!.width;
  await expect(aside).toHaveCSS('width', '308px');
  await expect.poll(async () => (await main.boundingBox())!.width).toBe(viewportWidth - 308);
  // The line toward the content belongs to the panel…
  await expect(panel(page)).toHaveCSS('border-inline-end-width', '1px');
  await expect(panel(page)).toHaveCSS('border-inline-end-color', 'rgb(232, 234, 242)');

  await railButton(page, 'תפעול').click(); // the shown category again
  await expect(panel(page)).toHaveAttribute('data-state', 'closed');
  await expect(aside).toHaveCSS('width', '72px');
  await expect.poll(async () => (await main.boundingBox())!.width).toBe(viewportWidth - 72);
  // …and goes with it. A closed panel is out of the tab order.
  await expect(panel(page)).toHaveCSS('border-inline-end-width', '0px');
  await expect(panel(page)).toHaveJSProperty('inert', true);
  // Closed: the rail marks the page's own category, and nothing else.
  await expect(railButton(page, 'תפעול')).toHaveAttribute('data-selected', 'true');
  await expect(railButton(page, 'תפעול')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe('1');

  // Reload: still closed, with no flash of an open panel afterwards.
  await page.reload();
  await expect(panel(page)).toHaveAttribute('data-state', 'closed');
  await expect(aside).toHaveCSS('width', '72px');

  // Any category opens it again — on that category, still no navigation.
  await railButton(page, 'כספים').click();
  await expect(panel(page)).toHaveAttribute('data-state', 'open');
  await expect(panel(page)).toHaveAttribute('data-nav-panel', 'finance');
  await expect(aside).toHaveCSS('width', '308px');
  expect(new URL(page.url()).pathname).toBe('/issues');
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe('0');

  // The collapse button (a double chevron, titled) closes it too.
  const collapse = panel(page).getByRole('button', { name: 'כיווץ תפריט' });
  await expect(collapse).toHaveAttribute('title', 'כיווץ תפריט');
  const box = (await collapse.boundingBox())!;
  expect([box.width, box.height]).toEqual([28, 28]);
  await collapse.click();
  await expect(panel(page)).toHaveAttribute('data-state', 'closed');
});

test('who sees what: the guard only "אבטחה", the viewer no "ראשי" and no "משתמשים", the admin "משתמשים" under "פורטל"', async ({ browser }) => {
  // — the guard: one category, no settings, a logout that is labelled for screen readers.
  const guard = await sessionFor(browser, people.guard.id);
  await guard.goto('/');
  await expect(guard).toHaveURL(/\/visitors$/);
  expect(await railLabels(guard)).toEqual(['אבטחה']);
  await expect(panel(guard)).toHaveAttribute('data-nav-panel', 'security');
  expect(await panelItems(panel(guard)).allInnerTexts()).toEqual(['סריקת כניסה']);
  await expect(guard.locator('aside a[href="/settings"]')).toHaveCount(0);
  await expect(guard.locator('aside').getByRole('button', { name: 'התנתק' })).toBeVisible();

  // — the viewer: the debtors screen is theirs, and only that.
  const viewer = await sessionFor(browser, people.viewer.id);
  await viewer.goto('/dashboard');
  const viewerLabels = await railLabels(viewer);
  expect(viewerLabels).toEqual(['כספים']);
  expect(viewerLabels).not.toContain('ראשי');
  expect(viewerLabels).not.toContain('פורטל');
  expect(await panelItems(panel(viewer)).allInnerTexts()).toEqual(['ניהול חיובים']);
  await expect(viewer.locator('aside a[href="/settings/users"]')).toHaveCount(0);

  // — the admin: every category, settings pinned last; "משתמשים" is in the portal's.
  const admin = await sessionFor(browser, people.admin.id);
  await admin.goto('/overview');
  expect(await railLabels(admin)).toEqual(['ראשי', 'כספים', 'דיירים', 'תפוצה', 'תפעול', 'רכש', 'פורטל', 'אבטחה', 'הגדרות']);
  await railButton(admin, 'פורטל').click();
  expect(await panelItems(panel(admin)).allInnerTexts()).toEqual(['החלטות ופרוטוקולים', 'התחברויות לפורטל', 'משתמשים']);
  await panel(admin).locator('a[data-nav-item="/settings/users"]').click();
  await expect(admin).toHaveURL(/\/settings\/users$/);
  // …and it is the page's item, not "general settings" as well.
  await expect(panel(admin).locator('a[aria-current="page"]')).toHaveText('משתמשים');
  await expect(panel(admin).locator('a[aria-current="page"]')).toHaveCount(1);
});

test('phone: the burger opens the rail and the panel, a category switches the list, an item navigates and closes', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/state.json', viewport: { width: 390, height: 844 }, hasTouch: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/dashboard');
  await expect(page.locator('aside').first()).toBeHidden(); // the desktop sidebar does not exist here
  await page.getByRole('button', { name: 'פתח תפריט' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  expect(Math.round((await drawer.boundingBox())!.width)).toBe(308); // 72 rail + 236 panel (sub-pixel noise while it slides in)
  await expect(drawer.locator('[data-nav-panel]')).toHaveAttribute('data-nav-panel', 'finance'); // the page's own category
  await expect(drawer.getByRole('button', { name: 'כיווץ תפריט' })).toHaveCount(0); // no collapsing in the drawer

  await drawer.locator('button[data-nav-category]', { hasText: /^דיירים$/ }).click();
  await expect(drawer.locator('[data-nav-panel]')).toHaveAttribute('data-nav-panel', 'residents');
  expect(new URL(page.url()).pathname).toBe('/dashboard');
  await expect(drawer).toBeVisible();
  // Touch targets: every item is at least 44px tall.
  for (const item of await drawer.locator('a[data-nav-item]').all()) {
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // …and so is every rail button.
  for (const b of await drawer.locator('nav[aria-label="קטגוריות ניווט"] button').all()) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  await drawer.locator('a[data-nav-item="/contacts"]').click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Reopened on the new page: its category is the one shown, its item the one marked.
  await page.getByRole('button', { name: 'פתח תפריט' }).click();
  await expect(page.getByRole('dialog').locator('[data-nav-panel]')).toHaveAttribute('data-nav-panel', 'residents');
  await expect(page.getByRole('dialog').locator('a[aria-current="page"]')).toHaveText('רשימת דיירים');
});

test('a short window (1366×620): settings and logout stay on screen and reachable, the categories scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/state.json', viewport: { width: 1366, height: 620 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/overview');

  const settings = railButton(page, 'הגדרות');
  const logout = page.locator('aside').getByRole('button', { name: 'התנתק' });
  for (const b of [settings, logout]) {
    await expect(b).toBeInViewport({ ratio: 1 });
    await b.click({ trial: true }); // actionable (visible, stable, not covered) — without logging the shared session out
  }
  const logo = page.locator('aside nav[aria-label="קטגוריות ניווט"] > div').first();
  await expect(logo).toBeInViewport({ ratio: 1 });

  // The strip does not fit in 620px, so the categories area scrolls by itself…
  const scroller = rail(page).locator(':scope > div').nth(1);
  const { scrollHeight, clientHeight, overflowY } = await scroller.evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY,
  }));
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  expect(overflowY).toBe('auto');
  // …and the last category can be reached.
  await railButton(page, 'אבטחה').scrollIntoViewIfNeeded();
  await expect(railButton(page, 'אבטחה')).toBeInViewport();
  await railButton(page, 'הגדרות').click();
  await expect(panel(page)).toHaveAttribute('data-nav-panel', 'settings');
  expect(new URL(page.url()).pathname).toBe('/overview');
});
