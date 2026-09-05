import { expect, type APIRequestContext } from '@playwright/test';

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
