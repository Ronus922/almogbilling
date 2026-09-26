import { test, expect } from '@playwright/test';

// The floating assistant ("עוזר אישי") must not exist in the resident preview
// (/finance?view=resident): that screen shows exactly what a resident will get,
// and the bot answers with other residents' debts. Outside the preview the
// seeded super_admin (a staff role with dashboard view) sees the button as before.
const FAB = '[data-agent-fab]';
const RESIDENT_BANNER = 'אתה צופה כמו דייר';

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 720 }],
  ['mobile 390px', { width: 390, height: 844 }],
] as const) {
  test(`resident view (${name}): the assistant button is not in the DOM`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/finance?view=resident');
    // The resident screen has rendered (banner) — only then is "no button" meaningful.
    await expect(page.getByText(RESIDENT_BANNER)).toBeVisible();
    await expect(page.locator(FAB)).toHaveCount(0);
  });
}

test('leaving the resident view brings the assistant button back', async ({ page }) => {
  await page.goto('/finance?view=resident');
  await expect(page.getByText(RESIDENT_BANNER)).toBeVisible();
  await expect(page.locator(FAB)).toHaveCount(0);

  await page.getByRole('button', { name: 'יציאה מתצוגת דייר' }).click();
  await page.waitForURL((u) => u.pathname === '/finance' && u.searchParams.get('view') !== 'resident');
  await expect(page.locator(FAB)).toBeVisible();
});

test('outside the resident view the seeded admin sees the assistant button', async ({ page }) => {
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'שקיפות כספית' })).toBeVisible();
  await expect(page.locator(FAB)).toBeVisible();
});
