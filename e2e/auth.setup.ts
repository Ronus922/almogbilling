import { test as setup, expect } from '@playwright/test';
import { E2E_USER, E2E_PASS } from './helpers';

export const STORAGE_STATE = 'e2e/.auth/state.json';

// Test 1 — login through the real form. Also the auth setup for the other
// specs: the session cookie is saved once, so a run costs exactly one login
// attempt against the per-IP rate limit.
setup('login: the seeded admin signs in through the form and gets a session', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('#username')).toBeVisible();
  await page.fill('#username', E2E_USER);
  await page.fill('#password', E2E_PASS);
  await page.locator('button[type="submit"]').click();

  // The form does window.location.href = '/' on success; the app then lands on
  // its home screen. Anything that is not /login is a successful redirect.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

  const me = await page.request.get('/api/auth/me');
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { user: { username: string; role: string } };
  expect(body.user.username).toBe(E2E_USER);
  expect(body.user.role).toBe('super_admin');

  await page.context().storageState({ path: STORAGE_STATE });
});
