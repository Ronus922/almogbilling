import { test, expect } from '@playwright/test';

// Test 5 — the file picker the USER actually sees. Two controls on /messages are
// called "צרף קובץ": the chat composer's paperclip (one file, by design) and the
// broadcast window's dropzone (up to 10). This guards the second one AS RENDERED
// inside the Sheet — that the input really carries `multiple`, and that one
// selection of two files lands as two rows. Reported twice as "only one file can
// be attached", both times from the single-file chat control.
//
// Storage is not reachable in CI, so the uploads themselves fail; what is asserted
// here is the picker accepting the selection, not the upload result.
test('broadcast window: the attachment input is multiple and takes two files at once', async ({ page }) => {
  await page.goto('/messages');
  await page.getByRole('button', { name: 'תפוצות' }).click();

  const sheet = page.getByRole('dialog').filter({ hasText: 'תפוצת WhatsApp' });
  await expect(sheet.getByText('קבצים מצורפים')).toBeVisible();

  // The input inside the Sheet — not the chat composer's, which has no `multiple`.
  const input = sheet.locator('input[type="file"]');
  await expect(input).toHaveCount(1);
  await expect(input).toHaveJSProperty('multiple', true);
  await expect(input).toHaveAttribute('accept', /\.pdf/);
  await expect(input).toHaveAttribute('accept', /\.mp4/);

  const pdf = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK',
    'base64',
  );
  await input.setInputFiles([
    { name: 'ראשון.pdf', mimeType: 'application/pdf', buffer: pdf },
    // An Office file the browser reports as a zip container (Chrome on Windows)
    // — refused before the fix in PR #12, which is what capped a pick at one file.
    { name: 'שני.docx', mimeType: 'application/zip', buffer: pdf },
  ]);

  const rows = sheet.locator('li:has(button[aria-label^="הסר"])');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('ראשון.pdf');
  await expect(rows.nth(1)).toContainText('שני.docx');
  // Neither was rejected by the client-side policy (an upload error may follow).
  await expect(sheet.getByText('סוג הקובץ אינו נתמך')).toHaveCount(0);
  await expect(sheet.getByText('אינו תואם לסיומת')).toHaveCount(0);

  // The dropzone stays available while under the 10-file cap.
  await expect(sheet.getByRole('button', { name: /צרף קבצים/ })).toBeEnabled();
});
