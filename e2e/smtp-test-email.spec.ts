import { test, expect } from '@playwright/test';
import { mailpitClear, mailpitMessages, saveSmtpSettings } from './helpers';

const TO = 'inbox@e2e.local';

// Test 4 — "send test email" goes through the real nodemailer transport to
// Mailpit (SMTP_HOST/PORT point at it), and the message is verified through
// Mailpit's API.
test('smtp test email: POST /api/settings/smtp/test lands in Mailpit', async ({ request }) => {
  await saveSmtpSettings(request);
  await mailpitClear(request);

  const send = await request.post('/api/settings/smtp/test', { data: { to: TO } });
  expect(send.status(), await send.text()).toBe(200);

  await expect
    .poll(async () => (await mailpitMessages(request)).filter((m) => m.To.some((t) => t.Address === TO)).length, {
      timeout: 20_000,
      message: 'test email did not reach Mailpit',
    })
    .toBeGreaterThan(0);

  const [msg] = (await mailpitMessages(request)).filter((m) => m.To.some((t) => t.Address === TO));
  expect(msg.Subject).toContain('ALMOG CRM');
  expect(msg.From.Address).toBe('e2e.billing@gmail.com');
});
