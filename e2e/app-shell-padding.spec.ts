import { test, expect } from '@playwright/test';

// AppShell's content gutter (DESIGN.md §32: `p-[18px] md:p-6`). From 13/08 to
// 10/10/2026 every page had 0px sides: `.safe-px` in the unlayered
// responsive.css outranked the layered Tailwind padding, so the content touched
// the sidebar and the screen edge. A desktop viewport has no safe-area insets,
// so the sides must be exactly the md gutter — the same value as the top.
test('the AppShell content keeps its side padding on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  const gutter = page.locator('main > div').first();
  await expect(gutter).toBeVisible();
  const pad = await gutter.evaluate((el) => {
    const s = getComputedStyle(el);
    return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight), top: parseFloat(s.paddingTop) };
  });
  expect(pad.left).toBeGreaterThan(0);
  expect(pad.right).toBeGreaterThan(0);
  expect(pad.left).toBe(pad.top);
  expect(pad.right).toBe(pad.top);
});
