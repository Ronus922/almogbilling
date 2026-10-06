import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

// The debtors screen's tab badges (06/10/2026): each badge counts what its
// tab's table lists under the CURRENT search. Before, the badges counted the
// whole building while the table honoured ?q= / ?apt= — and the two search
// boxes keep their value across tab clicks on purpose — so a name typed on
// "חייבים" followed by a click on "מכתבי התראה" showed a badge of 9 over an
// empty table. Fixtures from db/seed/e2e.sql: E2E-B sits in the default
// stage; the suite moves it into "מכתב התראה" and back. Its owner name on
// screen is the REGISTRY's (the apartment is linked to a contact), so the
// name to search is read from the database, not hardcoded.

const E2E_B = '00000000-0000-4000-8000-0000000e2e0b';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);
test.afterAll(async () => { await pool.end(); });

/** The owner name the screen shows and searches — through the registry when linked. */
async function ownerNameOnScreen(debtorId: string): Promise<string> {
  const r = await pool.query<{ name: string | null }>(
    `select case when rc.id is null then d.owner_name else rc.owner_name end as name
       from public.debtors d left join public.contacts rc on rc.id = d.contact_id where d.id = $1`,
    [debtorId],
  );
  expect(r.rows[0]?.name, 'the seeded debtor has an owner name').toBeTruthy();
  return r.rows[0]!.name!;
}
const TABS = [
  { key: '', label: 'חייבים' },
  { key: 'warning', label: 'מכתבי התראה' },
  { key: 'legal-care', label: 'לטיפול משפטי' },
  { key: 'legal-proceeding', label: 'הליך משפטי' },
  { key: 'actions', label: 'פעולות' },
  { key: 'archived', label: 'ארכיון' },
] as const;

const tabButton = (page: Page, label: string) => page.locator('button', { hasText: label }).filter({ has: page.locator('.font-num') }).first();
const badge = async (page: Page, label: string) => Number(await tabButton(page, label).locator('.font-num').innerText());
const toolbarTotal = async (page: Page) => Number(await page.locator('h2:has-text("טבלת חייבים") + span .font-num').innerText());
const rowCount = (page: Page) => page.locator('table tbody tr').count();

interface StatusRow { id: string; name: string; is_default?: boolean }
async function statusIds(page: Page): Promise<{ warning: string; normal: string }> {
  const res = await page.request.get('/api/statuses');
  expect(res.status()).toBe(200);
  const statuses = (await res.json()) as StatusRow[];
  const warning = statuses.find((s) => s.name === 'מכתב התראה');
  const normal = statuses.find((s) => s.is_default) ?? statuses.find((s) => s.name === 'רגיל');
  expect(warning, 'seeded status "מכתב התראה" missing').toBeTruthy();
  expect(normal, 'default status missing').toBeTruthy();
  return { warning: warning!.id, normal: normal!.id };
}
async function setStatus(page: Page, statusId: string) {
  const put = await page.request.put(`/api/debtors/${E2E_B}/legal-status`, { data: { status_id: statusId } });
  expect(put.status(), await put.text()).toBe(200);
}

test.describe('debtors tabs — the badge is the table', () => {
  test('with no search every badge equals its table total and its rows', async ({ page }) => {
    for (const t of TABS) {
      await page.goto(t.key ? `/dashboard?tab=${t.key}` : '/dashboard');
      const b = await badge(page, t.label);
      const total = await toolbarTotal(page);
      expect(b, t.label).toBe(total);
      expect(Math.min(total, 50), t.label).toBe(await rowCount(page));
    }
  });

  test('a search that matches nothing: badge 0, total 0, the empty state — on the warning tab too', async ({ page }) => {
    await page.goto('/dashboard?tab=warning&q=NO-SUCH-OWNER-E2E');
    expect(await badge(page, 'מכתבי התראה')).toBe(0);
    expect(await toolbarTotal(page)).toBe(0);
    await expect(page.getByText('אין נתונים להצגה')).toBeVisible();
    for (const t of TABS) expect(await badge(page, t.label), t.label).toBe(0);
    await expect(page.locator('input[value="NO-SUCH-OWNER-E2E"]')).toBeVisible();
  });

  test('the search sticks across tab clicks and the badges follow it (the reported case)', async ({ page }) => {
    const { normal } = await statusIds(page);
    await setStatus(page, normal);
    const q = await ownerNameOnScreen(E2E_B);
    await page.goto(`/dashboard?q=${encodeURIComponent(q)}`);
    const active = await badge(page, 'חייבים');
    expect(active).toBeGreaterThanOrEqual(1);
    expect(active).toBe(await toolbarTotal(page));
    await expect(page.locator('table tbody tr', { hasText: 'E2E-B' })).toHaveCount(1);
    const warning = await badge(page, 'מכתבי התראה');

    await tabButton(page, 'מכתבי התראה').click();
    await expect(page).toHaveURL(/tab=warning/);
    expect(new URL(page.url()).searchParams.get('q')).toBe(q); // the search survived the click
    // the badges did not change — they already told where the searched owner is
    expect(await badge(page, 'חייבים')).toBe(active);
    expect(await badge(page, 'מכתבי התראה')).toBe(warning);
    expect(await toolbarTotal(page)).toBe(warning); // …and the table shows exactly that many
    await expect(page.locator('table tbody tr', { hasText: 'E2E-B' })).toHaveCount(0);
    if (warning === 0) await expect(page.getByText('אין נתונים להצגה')).toBeVisible();
  });

  test('moving a debtor into the stage and out again moves the badge with the row', async ({ page }) => {
    const { warning, normal } = await statusIds(page);
    await setStatus(page, normal);
    await page.goto('/dashboard?tab=warning');
    const before = await badge(page, 'מכתבי התראה');
    expect(before).toBe(await toolbarTotal(page));
    await expect(page.getByText('E2E-B', { exact: true })).toHaveCount(0);

    await setStatus(page, warning);
    await page.reload();
    expect(await badge(page, 'מכתבי התראה')).toBe(before + 1);
    expect(await toolbarTotal(page)).toBe(before + 1);
    await expect(page.locator('table tbody tr', { hasText: 'E2E-B' })).toHaveCount(1);
    // the other stage lost it
    expect(await badge(page, 'חייבים')).toBe((await (async () => { await page.goto('/dashboard'); return toolbarTotal(page); })()));

    await page.goto('/dashboard?tab=warning');
    await setStatus(page, normal);
    await page.reload();
    expect(await badge(page, 'מכתבי התראה')).toBe(before);
    expect(await toolbarTotal(page)).toBe(before);
    await expect(page.locator('table tbody tr', { hasText: 'E2E-B' })).toHaveCount(0);
  });

  test('changing the status from the panel refreshes the badges in place — no reload', async ({ page }) => {
    const { normal } = await statusIds(page);
    await setStatus(page, normal);
    await page.goto('/dashboard?tab=warning');
    const before = await badge(page, 'מכתבי התראה');

    await page.goto('/dashboard?apt=E2E-B');
    expect(await toolbarTotal(page)).toBe(1);
    await page.locator('table tbody tr', { hasText: 'E2E-B' }).click();
    const panel = page.locator('[role="dialog"]');
    await expect(panel).toBeVisible();
    await panel.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'מכתב התראה' }).click();
    await expect(page.getByText('הסטטוס עודכן')).toBeVisible();

    // router.refresh() re-renders the server page: the search is still on,
    // so E2E-B leaves "חייבים" (0) and lands on "מכתבי התראה" (1) in place.
    await expect.poll(() => badge(page, 'מכתבי התראה')).toBe(1);
    expect(await badge(page, 'חייבים')).toBe(0);

    await setStatus(page, normal);
    await page.goto('/dashboard?tab=warning');
    expect(await badge(page, 'מכתבי התראה')).toBe(before);
  });
});
