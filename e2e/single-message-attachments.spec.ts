import { test, expect } from '@playwright/test';

// Test 6 — the "שליחת הודעת WhatsApp" sheet of ONE debtor takes up to five files.
// Asserted on the screen the user actually opens (debtors table → row action),
// not on the component in isolation: the input must really carry `multiple`, and
// ONE selection of two files must land as two rows AND two lines in the preview.
//
// Storage is not reachable in CI, so the staging endpoint is stubbed: the point
// here is the composer — the input really being `multiple`, one selection of two
// files becoming two rows, and the live preview listing BOTH (it lists only files
// that are on their way, so a stub that succeeds is what exercises it).
test('single-recipient sheet: two files in one pick, listed and previewed', async ({ page }) => {
  let staged = 0;
  await page.route('**/api/whatsapp/messages/attachments', async (route) => {
    staged += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: `00000000-0000-4000-8000-00000000000${staged}`, original_name: 'x', mime_type: 'application/pdf', size_bytes: 1 }),
    });
  });

  await page.goto('/dashboard');

  // The row action of the seeded debtor (apartment E2E-101, which has a phone).
  // The table renders a mobile card list AND a desktop table; only one of the two
  // copies of the action is visible at any width.
  const openSheet = page.locator('button[aria-label="שליחת WhatsApp"]:visible').first();
  await expect(openSheet).toBeVisible({ timeout: 15_000 });
  await openSheet.click();

  const sheet = page.getByRole('dialog').filter({ hasText: 'שליחת הודעת WhatsApp' });
  await expect(sheet.getByText('קבצים מצורפים')).toBeVisible();

  const input = sheet.locator('input[type="file"]');
  await expect(input).toHaveCount(1);
  await expect(input).toHaveJSProperty('multiple', true);
  await expect(input).toHaveAttribute('accept', /\.pdf/);

  const pdf = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK',
    'base64',
  );
  await input.setInputFiles([
    { name: 'ראשון.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'שני.png', mimeType: 'image/png', buffer: pdf },
  ]);

  const rows = sheet.locator('li:has(button[aria-label^="הסר"])');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'הועלה' })).toHaveCount(2);
  expect(staged).toBe(2);
  await expect(rows.nth(0)).toContainText('ראשון.pdf');
  await expect(rows.nth(1)).toContainText('שני.png');
  // Neither was refused by the client-side policy.
  await expect(sheet.getByText('סוג הקובץ אינו נתמך')).toHaveCount(0);
  await expect(sheet.getByText('ניתן לצרף עד')).toHaveCount(0);

  // Each name appears twice: once in the attachment row, once in the live
  // preview under the message — i.e. the preview lists every file, not just one.
  await expect(sheet.getByText('ראשון.pdf')).toHaveCount(2);
  await expect(sheet.getByText('שני.png')).toHaveCount(2);

  // Five is the cap here (the broadcast's is ten).
  await expect(sheet.getByText(/עד 5 קבצים/)).toBeVisible();
});
