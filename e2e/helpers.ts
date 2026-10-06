import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Fixtures from db/seed/e2e.sql
export const E2E_USER = 'e2e-admin';
export const E2E_PASS = 'E2e-Passw0rd!';
export const E2E_DEBTOR_ID = '00000000-0000-4000-8000-0000000e2e01';

// Mailpit HTTP API (docker-compose.e2e.yml)
export const MAILPIT_URL =
  process.env.MAILPIT_URL ?? `http://localhost:${process.env.MAILPIT_HTTP_PORT ?? 55580}`;

// SMTP settings the suite saves. The PUT route insists on a Gmail address and a
// 16-char App Password; Mailpit accepts any credentials, so these are dummies.
export const SMTP_FIXTURE = {
  fromEmail: 'e2e.billing@gmail.com',
  fromName: 'E2E Billing',
  password: 'abcdefghijklmnop',
};

export interface MailpitMessage {
  ID: string;
  From: { Address: string; Name: string };
  To: { Address: string; Name: string }[];
  Subject: string;
  Snippet: string;
}

export async function saveSmtpSettings(request: APIRequestContext): Promise<void> {
  const res = await request.put('/api/settings/smtp', { data: SMTP_FIXTURE });
  expect(res.status(), await res.text()).toBe(200);
}

export async function mailpitMessages(request: APIRequestContext): Promise<MailpitMessage[]> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/messages?limit=50`);
  expect(res.ok(), `Mailpit API unreachable at ${MAILPIT_URL}`).toBeTruthy();
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

export async function mailpitClear(request: APIRequestContext): Promise<void> {
  const res = await request.delete(`${MAILPIT_URL}/api/v1/messages`);
  expect(res.ok()).toBeTruthy();
}

/** The login form, like auth.setup — the only way a session cookie reaches a
 *  production-mode sandbox. A fresh context (no shared storage state), so a
 *  second user can act beside the seeded e2e-admin. `ok` is false when the
 *  form kept the user on /login. */
export async function loginThroughForm(
  browser: Browser,
  username: string,
  password: string,
): Promise<{ ctx: BrowserContext; page: Page; ok: boolean }> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.locator('button[type="submit"]').click();
  const ok = await page
    .waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 })
    .then(() => true, () => false);
  return { ctx, page, ok };
}
