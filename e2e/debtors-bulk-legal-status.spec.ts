import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { MAILPIT_URL, loginThroughForm, mailpitClear, mailpitMessages, saveSmtpSettings } from './helpers';

// Bulk legal-status change on the debtors table: tick apartments, pick a status
// in the sticky bar, confirm in a dialog — one action, one history row per
// apartment, ONE consolidated mail. Driven as the seeded super admin; the
// non-admin cases use a temporary manager and viewer. Fixtures are numeric
// apartments far from the seed (9902xx / 9903xx); every row made here is removed
// by the exact id it recorded (CLAUDE.md iron rule 12) — debtors (their history
// cascades), the temporary status and users, and the audit rows the user
// creation wrote.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const uniq = `lsbulk-e2e-${Date.now()}`;
const PASSWORD = 'E2e-Temp0rary!';
const TARGET_EMAIL = 'bulk-e2e@example.test';
const STATUS_NAME = `בדיקת באלק ${uniq}`;
const A = ['990201', '990202', '990203'];

const made = { debtors: [] as string[], status: '', users: [] as string[] };
const aIds: Record<string, string> = {};
let managerEmail = '';
let viewerEmail = '';
const ctxs: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  for (const c of ctxs) await c.close();
  for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]); // history cascades
  if (made.status) await pool.query(`delete from public.statuses where id = $1`, [made.status]);
  const audit = await pool.query<{ id: string }>(
    `select id from public.audit_log where entity_id = any($1::text[]) or actor_user_id = any($2::uuid[])`,
    [made.users, made.users],
  );
  for (const r of audit.rows) await pool.query(`delete from public.audit_log where id = $1`, [r.id]);
  for (const id of made.users) await pool.query(`delete from public.users where id = $1`, [id]);
  await pool.end();
});

const bar = (page: Page) => page.getByRole('region', { name: 'פעולות על הדירות שנבחרו' });
const rowBox = (page: Page, apt: string) => page.getByRole('checkbox', { name: `בחר דירה ${apt}` });
/** A tick made before React hydrates does nothing — retry until it holds. */
const tick = (box: Locator) => expect(async () => { await box.check({ timeout: 2_000 }); }).toPass({ timeout: 15_000 });
const historyCount = async (apt: string) =>
  Number((await pool.query<{ c: string }>(
    `select count(*)::text as c from public.legal_status_history where apartment_number = $1`, [apt],
  )).rows[0]!.c);
const statusOfApt = async (apt: string) =>
  (await pool.query<{ legal_status_id: string | null }>(
    `select legal_status_id from public.debtors where apartment_number = $1`, [apt],
  )).rows[0]!.legal_status_id;

/** Nothing in the bar sits under the assistant's floating button. */
async function expectClearOfAssistantButton(page: Page) {
  const fab = (await page.locator('button[aria-label="עוזר אישי"]').first().boundingBox())!;
  for (const el of await bar(page).locator('button, [role="combobox"]').all()) {
    const b = (await el.boundingBox())!;
    const overlaps = b.x < fab.x + fab.width && b.x + b.width > fab.x && b.y < fab.y + fab.height && b.y + b.height > fab.y;
    expect(overlaps, 'a bar control overlaps the assistant button').toBe(false);
  }
}

/**
 * A box that has stopped moving. Right after a state change the layout is still
 * settling for a moment (the bar mounts, the page re-flows, the scroll position
 * adjusts), and a single `boundingBox()` read can land in the middle of it — the
 * measurement is taken only once two consecutive reads agree.
 */
async function settledBox(locator: Locator) {
  let previous = '';
  let box = null as Awaited<ReturnType<Locator['boundingBox']>>; // assigned in the poll callback
  await expect.poll(async () => {
    box = await locator.boundingBox();
    const now = JSON.stringify(box);
    const settled = box !== null && now === previous;
    previous = now;
    return settled;
  }, { message: 'the layout settles' }).toBe(true);
  return box!;
}

async function pickStatus(page: Page, name: string) {
  await bar(page).getByRole('combobox').click();
  await page.getByRole('option', { name }).click();
}

test.describe('bulk legal status — as the super admin', () => {
  test('fixtures: three apartments, a status with a mail address, a clean mailbox', async ({ page }) => {
    for (const apt of A) {
      const r = await pool.query<{ id: string }>(
        `insert into public.debtors (apartment_number, owner_name, total_debt, management_fees, hot_water_debt, special_debt, is_archived)
         values ($1, $2, 0, 0, 0, 0, false) returning id`,
        [apt, `בעלים ${apt}`],
      );
      aIds[apt] = r.rows[0]!.id;
      made.debtors.push(r.rows[0]!.id);
    }
    const st = await pool.query<{ id: string }>(
      `insert into public.statuses (name, color, is_active, sort_order, notification_emails)
       values ($1, '#0ea5e9', true, 998, $2) returning id`,
      [STATUS_NAME, [TARGET_EMAIL]],
    );
    made.status = st.rows[0]!.id;
    await saveSmtpSettings(page.request);
    await mailpitClear(page.request);

    // the two users the non-admin cases need
    const make = async (role: string, tag: string) => {
      const email = `${uniq}-${tag}@billing.local`;
      const res = await page.request.post('/api/users', { data: { email, full_name: `${tag} ${uniq}`, role, password: PASSWORD } });
      expect(res.status(), await res.text()).toBe(201);
      made.users.push(((await res.json()) as { id: string }).id);
      return email;
    };
    managerEmail = await make('manager', 'mgr');
    viewerEmail = await make('viewer', 'view');
  });

  test('the header box selects every listed row, and clears them; no bar until something is ticked', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    for (const apt of A) await expect(rowBox(page, apt)).toBeVisible();
    await expect(bar(page)).toHaveCount(0);

    await tick(page.getByRole('checkbox', { name: 'בחר הכל' }));
    await expect(bar(page)).toContainText('נבחרו 3 דירות');
    for (const apt of A) await expect(rowBox(page, apt)).toBeChecked();

    await page.getByRole('checkbox', { name: 'בחר הכל' }).uncheck();
    await expect(bar(page)).toHaveCount(0);

    await tick(rowBox(page, A[0]!));
    await expect(bar(page)).toContainText('נבחרה דירה אחת');
  });

  test('"עדכן סטטוס" waits for a status; the dialog names it and the apartments; cancel changes nothing', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    await tick(rowBox(page, A[0]!));
    await tick(rowBox(page, A[1]!));
    await expect(bar(page).getByRole('button', { name: 'עדכן סטטוס' })).toBeDisabled();

    await pickStatus(page, STATUS_NAME);
    await bar(page).getByRole('button', { name: 'עדכן סטטוס' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('לעדכן סטטוס משפטי ל-2 דירות?');
    await expect(dialog).toContainText(STATUS_NAME);
    await expect(dialog.getByText(A[0]!, { exact: true })).toBeVisible();
    await expect(dialog.getByText(A[1]!, { exact: true })).toBeVisible();
    await expect(dialog.getByText(A[2]!, { exact: true })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'ביטול' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await statusOfApt(A[0]!)).toBeNull();
    expect(await historyCount(A[0]!)).toBe(0);
    await expect(bar(page)).toContainText('נבחרו 2 דירות'); // the selection survives a cancel
  });

  test('confirm updates both apartments, writes a history row each, clears the selection, and sends ONE mail', async ({ page }) => {
    await mailpitClear(page.request);
    await page.goto('/dashboard?apt=9902');
    await tick(rowBox(page, A[0]!));
    await tick(rowBox(page, A[1]!));
    await pickStatus(page, STATUS_NAME);
    await bar(page).getByRole('button', { name: 'עדכן סטטוס' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'עדכן סטטוס' }).click();

    await expect(page.getByText('עודכן סטטוס משפטי ל-2 דירות')).toBeVisible();
    await expect(bar(page)).toHaveCount(0); // selection cleared
    await expect(rowBox(page, A[0]!)).not.toBeChecked();

    // the table shows the new status on the two rows and not on the third
    await expect(page.locator('tbody tr', { hasText: A[0]! })).toContainText(STATUS_NAME);
    await expect(page.locator('tbody tr', { hasText: A[1]! })).toContainText(STATUS_NAME);
    await expect(page.locator('tbody tr', { hasText: A[2]! })).not.toContainText(STATUS_NAME);

    const target = made.status;
    expect(await statusOfApt(A[0]!)).toBe(target);
    expect(await statusOfApt(A[1]!)).toBe(target);
    expect(await statusOfApt(A[2]!)).toBeNull();
    expect(await historyCount(A[0]!)).toBe(1);
    expect(await historyCount(A[1]!)).toBe(1);
    expect(await historyCount(A[2]!)).toBe(0);

    // exactly ONE mail for the whole action, to the status's address, naming both
    await expect.poll(async () => (await mailpitMessages(page.request)).filter((m) => m.To.some((t) => t.Address === TARGET_EMAIL)).length, { timeout: 15_000 }).toBe(1);
    const mails = (await mailpitMessages(page.request)).filter((m) => m.To.some((t) => t.Address === TARGET_EMAIL));
    expect(mails[0]!.Subject).toBe('עדכון סטטוס משפטי — 2 דירות');
    // (Mailpit's Snippet is only the first ~100 characters — read the whole text)
    const full = (await (await page.request.get(`${MAILPIT_URL}/api/v1/message/${mails[0]!.ID}`)).json()) as { Text: string };
    expect(full.Text).toContain(`דירה ${A[0]!}`);
    expect(full.Text).toContain(`דירה ${A[1]!}`);
    expect(full.Text).not.toContain(`דירה ${A[2]!}`);
    expect(full.Text).toContain('(ללא סטטוס) ←'); // old ← new, per apartment
  });

  test('an apartment already on the status is skipped and the toast says so', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    await tick(page.getByRole('checkbox', { name: 'בחר הכל' })); // 3 ticked, 2 already on the target
    await pickStatus(page, STATUS_NAME);
    await bar(page).getByRole('button', { name: 'עדכן סטטוס' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('2 מהן כבר בסטטוס הזה');
    await page.getByRole('alertdialog').getByRole('button', { name: 'עדכן סטטוס' }).click();
    await expect(page.getByText('עודכן סטטוס משפטי לדירה אחת · 2 כבר היו בסטטוס הזה')).toBeVisible();
    expect(await historyCount(A[2]!)).toBe(1);
    expect(await historyCount(A[0]!)).toBe(1); // not written a second time
  });

  test('changing the search or the tab clears the selection', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    await tick(rowBox(page, A[2]!));
    await expect(bar(page)).toBeVisible();

    await page.getByPlaceholder('שם בעלים...').fill('בעלים');
    await expect(page).toHaveURL(/q=/);
    await expect(bar(page)).toHaveCount(0);
    await page.getByPlaceholder('שם בעלים...').fill('');
    await expect(page).not.toHaveURL(/q=/);

    await tick(rowBox(page, A[2]!));
    await expect(bar(page)).toBeVisible();
    await page.locator('button', { hasText: 'מכתבי התראה' }).filter({ has: page.locator('.font-num') }).first().click();
    await expect(page).toHaveURL(/tab=warning/);
    await expect(bar(page)).toHaveCount(0);
    await page.locator('button', { hasText: 'חייבים' }).filter({ has: page.locator('.font-num') }).first().click();
    await expect(rowBox(page, A[2]!)).not.toBeChecked();
  });

  test('the WhatsApp action still lives in the same bar', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    await tick(rowBox(page, A[0]!));
    await bar(page).getByRole('button', { name: 'שליחת WhatsApp' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('bulk legal status — the bar is a sticky one and keeps clear of the assistant button', () => {
  test('55 apartments: the bar is on screen wherever the rows are, and clear of the assistant button', async ({ page }) => {
    const r = await pool.query<{ id: string }>(
      `insert into public.debtors (apartment_number, owner_name, total_debt, management_fees, hot_water_debt, special_debt, is_archived)
       select (990300 + g)::text, $1 || g, 0, 0, 0, 0, false from generate_series(0, 54) g returning id`,
      [`בעלים ב ${uniq} `],
    );
    made.debtors.push(...r.rows.map((x) => x.id));

    await page.goto('/dashboard?apt=9903');
    const fabAtRest = (await page.locator('button[aria-label="עוזר אישי"]').first().boundingBox())!;
    await tick(page.getByRole('checkbox', { name: 'בחר הכל' }));
    await expect(bar(page)).toContainText('נבחרו 50 דירות'); // one page, not the 55

    // Wherever the user is in the table — its first row, the middle, the last
    // — the bar is on screen. (Above the table, with no row in view, it is not:
    // a sticky-bottom bar cannot leave the box of the table it belongs to.)
    const vh = page.viewportSize()!.height;
    const rows = page.locator('tbody tr');
    for (const [where, index] of [['first row', 0], ['middle', 25], ['last row', 49]] as const) {
      await rows.nth(index).evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const box = (await bar(page).boundingBox())!;
      expect(box.y, `bar top at the ${where}`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `bar bottom at the ${where}`).toBeLessThanOrEqual(vh);
    }
    expect(await bar(page).evaluate((el) => getComputedStyle(el).position)).toBe('sticky');

    await expectClearOfAssistantButton(page);
    // From `md` the bar leaves its own room (pl-14), so the button does not move — only
    // on a phone, where the bar is full width, does it ride up (see below).
    expect((await page.locator('button[aria-label="עוזר אישי"]').first().boundingBox())!.y).toBe(fabAtRest.y);
  });
});

test.describe('bulk legal status — on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // The regression this pins (26–27/10/2026): the bar was `sticky` inside the table's
  // box, and a sticky element cannot leave its parent — with the select-all row near
  // the bottom of the screen the (≈250px tall, one control per row) bar was clamped to
  // the table's top edge and sat BELOW the fold (top 812, bottom 1052 on a 844 screen,
  // exactly what CI measured). On a phone it is `fixed`: flush with the bottom edge
  // wherever the table is, and the list leaves room for it.
  test('the bar is fixed to the bottom edge wherever the table is, and the last card clears it', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    const selectAll = page.getByRole('checkbox', { name: 'בחר הכל' });
    await expect(selectAll).toBeVisible();
    const { width: vw, height: vh } = page.viewportSize()!;
    const main = page.locator('main');
    const flushWithBottomEdge = async () => {
      const b = (await bar(page).boundingBox())!;
      return { x: b.x, right: b.x + b.width, gap: vh - (b.y + b.height) };
    };

    // 1) ticking from every place the select-all row can be: nearly off the bottom
    //    of the screen (the failing one), mid-screen, and at the top.
    for (const top of [vh - 24, Math.round(vh / 2), 8]) {
      await selectAll.evaluate((el, target) => {
        const m = document.querySelector('main')!;
        m.scrollTop += el.getBoundingClientRect().top - target;
      }, top);
      await tick(selectAll);
      await expect(bar(page)).toContainText('נבחרו 3 דירות');
      await expect.poll(flushWithBottomEdge, { message: `bar flush with the bottom edge (row at ${top}px)` })
        .toEqual({ x: 0, right: vw, gap: 0 });
      await bar(page).getByRole('button', { name: 'נקה בחירה' }).click();
      await expect(bar(page)).toHaveCount(0);
    }

    // 2) with the bar up, scrolled to the very top of the page (the table far below,
    //    off screen) and to the very end — it is on screen both times, and at the
    //    end the last card sits above it instead of behind it.
    await tick(selectAll);
    await expect(bar(page)).toContainText('נבחרו 3 דירות');
    await main.evaluate((m) => { m.scrollTop = 0; });
    await expect.poll(flushWithBottomEdge, { message: 'bar still on screen at the top of the page' })
      .toEqual({ x: 0, right: vw, gap: 0 });
    await main.evaluate((m) => { m.scrollTop = m.scrollHeight; });
    const lastCard = page.locator('li').filter({ has: page.getByRole('checkbox', { name: /^בחר דירה / }) }).last();
    await expect.poll(async () => {
      const card = (await lastCard.boundingBox())!;
      const b = (await bar(page).boundingBox())!;
      return Math.round(b.y - (card.y + card.height)); // gap between the last card and the bar
    }, { message: 'the last card clears the bar at the end of the page' }).toBeGreaterThanOrEqual(0);
  });

  // The PWA install banner is fixed to the same strip (z-40). Standing in for it is
  // enough: the rule keys on the `data-install-banner` attribute, as the FAB's does.
  test('the install banner steps aside while the bar is up, and comes back after', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    await expect(page.getByRole('checkbox', { name: 'בחר הכל' })).toBeVisible();
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div id="fake-install-banner" data-install-banner="">התקנה</div>');
    });
    const banner = page.locator('#fake-install-banner');
    await expect(banner).toBeVisible();

    await tick(page.getByRole('checkbox', { name: 'בחר הכל' }));
    await expect(bar(page)).toContainText('נבחרו 3 דירות');
    await expect(banner).toBeHidden();

    await bar(page).getByRole('button', { name: 'נקה בחירה' }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect(banner).toBeVisible();
    await page.evaluate(() => document.getElementById('fake-install-banner')?.remove());
  });

  // The bar is full width now, so the assistant's round button (fixed bottom-left)
  // would sit on its controls — a real phone showed it half over "שליחת WhatsApp".
  // It rides above the bar instead, and drops back to its place when the bar goes.
  test('the assistant button rides above the bar — and so does its panel — instead of covering it', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    const selectAll = page.getByRole('checkbox', { name: 'בחר הכל' });
    await expect(selectAll).toBeVisible();
    const fab = page.locator('button[aria-label="עוזר אישי"]').first();
    const atRest = (await fab.boundingBox())!;
    const gapAboveBar = async (el: Locator) => {
      const e = (await el.boundingBox())!;
      const b = (await bar(page).boundingBox())!;
      return Math.round(b.y - (e.y + e.height));
    };

    await tick(selectAll);
    await expect(bar(page)).toContainText('נבחרו 3 דירות');
    await expect.poll(() => gapAboveBar(fab), { message: 'the button is above the bar' }).toBeGreaterThanOrEqual(0);
    await expectClearOfAssistantButton(page);

    // Its chat panel is anchored above the button, so it clears the bar too.
    await fab.click();
    const panel = page.getByRole('dialog', { name: 'עוזר אישי' });
    await expect(panel).toBeVisible();
    await expect.poll(() => gapAboveBar(panel), { message: 'the panel is above the bar' }).toBeGreaterThanOrEqual(0);
    expect((await panel.boundingBox())!.y, 'the panel stays on screen').toBeGreaterThanOrEqual(0);
    await fab.click(); // the button toggles the panel closed
    await expect(panel).toHaveCount(0);

    await bar(page).getByRole('button', { name: 'נקה בחירה' }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect.poll(async () => (await fab.boundingBox())!.y, { message: 'the button is back in its place' }).toBe(atRest.y);
  });

  test('the cards get a select-all row, and the bar is reachable with 44px controls', async ({ page }) => {
    await page.goto('/dashboard?apt=9902');
    await expect(page.getByRole('checkbox', { name: 'בחר הכל' })).toBeVisible();
    await tick(page.getByRole('checkbox', { name: 'בחר הכל' }));
    await expect(bar(page)).toContainText('נבחרו 3 דירות');

    const box = await settledBox(bar(page));
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    for (const name of ['עדכן סטטוס', 'נקה בחירה']) {
      const b = await settledBox(bar(page).getByRole('button', { name }));
      expect(b.height, name).toBeGreaterThanOrEqual(44);
    }
    expect((await settledBox(bar(page).getByRole('combobox'))).height).toBeGreaterThanOrEqual(44);
    await expectClearOfAssistantButton(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // no horizontal scroll
  });
});

test.describe('bulk legal status — not for everyone', () => {
  test('a viewer sees no checkboxes at all and gets 403 on the route', async ({ browser }) => {
    const login = await loginThroughForm(browser, viewerEmail, PASSWORD);
    expect(login.ok, 'the temp viewer logs in').toBe(true);
    ctxs.push(login.ctx);
    await login.page.goto('/dashboard?apt=9902');
    await expect(login.page.locator('tbody tr', { hasText: A[0]! })).toBeVisible();
    await expect(login.page.getByRole('checkbox')).toHaveCount(0);
    const res = await login.page.request.put('/api/debtors/legal-status/bulk', {
      data: { debtor_ids: [aIds[A[2]!]], status_id: made.status },
    });
    expect(res.status()).toBe(403);
  });

  test('a manager has the checkboxes (WhatsApp) but no status controls, and the route says 403', async ({ browser }) => {
    const before = await historyCount(A[2]!);
    const login = await loginThroughForm(browser, managerEmail, PASSWORD);
    expect(login.ok, 'the temp manager logs in').toBe(true);
    ctxs.push(login.ctx);
    const page = login.page;
    await page.goto('/dashboard?apt=9902');
    await tick(rowBox(page, A[2]!));
    await expect(bar(page).getByRole('button', { name: 'שליחת WhatsApp' })).toBeVisible();
    await expect(bar(page).getByRole('combobox')).toHaveCount(0);
    await expect(bar(page).getByRole('button', { name: 'עדכן סטטוס' })).toHaveCount(0);

    const res = await page.request.put('/api/debtors/legal-status/bulk', {
      data: { debtor_ids: [aIds[A[2]!]], status_id: made.status },
    });
    expect(res.status()).toBe(403);
    expect(await historyCount(A[2]!)).toBe(before); // nothing written
    // …while the single-apartment route is still the manager's (status_management:edit)
    const single = await page.request.put(`/api/debtors/${aIds[A[2]!]}/legal-status`, { data: { status_id: made.status } });
    expect(single.status()).toBe(200);
  });
});
