import { test, expect } from '@playwright/test';
import { SMTP_FIXTURE, saveSmtpSettings } from './helpers';

interface SmtpPublic { fromEmail: string; fromName: string; hasPassword: boolean }

// Test 3 — save SMTP settings (encrypted at rest with SETTINGS_ENC_KEY) and
// read the public view back; the password never comes back.
test('smtp settings: PUT saves, GET returns the public view', async ({ request }) => {
  await saveSmtpSettings(request);

  const get = await request.get('/api/settings/smtp');
  expect(get.status()).toBe(200);
  const body = (await get.json()) as SmtpPublic;
  expect(body).toEqual({
    fromEmail: SMTP_FIXTURE.fromEmail,
    fromName: SMTP_FIXTURE.fromName,
    hasPassword: true,
  });
  expect(JSON.stringify(body)).not.toContain(SMTP_FIXTURE.password);

  // Validation still bites: a non-Gmail sender is rejected with 400.
  const bad = await request.put('/api/settings/smtp', {
    data: { ...SMTP_FIXTURE, fromEmail: 'someone@example.com' },
  });
  expect(bad.status()).toBe(400);
});
