import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

// The portal by ROLE (03/10/2026), end to end on the db/seed/e2e.sql
// fixtures: a tenant (E2E-T) and an operator (E2E-O) linked through their
// cards. The identity-approval gate and the apartment card's "אותו אדם?"
// entry warning this file used to also cover were removed outright on
// 17/10/2026 ("פישוט גישת פורטל") — there is no more blocked-phone screen
// and no more approval step; see tests/portal-roles-identity.test.ts and
// tests/portal-ownership.test.ts for the DB-level coverage of "several
// apartments under different names never withhold access".
//
// The header assertion below was rewritten the same day ("כותרת הפורטל —
// ברכה בלבד"): the header greets by first name alone ("שלום, {first name}")
// and no longer repeats the apartment/role line — that still shows in
// "החשבון שלי" (#t-acc), asserted on its own below.

test.use({ storageState: { cookies: [], origins: [] } });

async function resident(browser: Browser, token: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await ctx.addCookies([{ name: 'portal_session', value: token, domain: 'localhost', path: '/' }]);
  return ctx;
}

for (const r of [
  { token: 'e2e-tenant-t', name: 'טל שוכרת E2E', apt: 'E2E-T', role: 'שוכר', debt: '₪500' },
  { token: 'e2e-operator-o', name: 'עומר מפעיל E2E', apt: 'E2E-O', role: 'מפעיל', debt: '₪0' },
]) {
  test(`a ${r.role} sees the building, the apartment debt with a role tag, and may report`, async ({ browser }) => {
    const ctx = await resident(browser, r.token);
    const page = await ctx.newPage();
    await page.goto('/portal?tab=acc');
    // the header: a one-line greeting by first name only, no apartment/role
    await expect(page.locator('.me .nm')).toHaveText(`שלום, ${r.name.split(' ')[0]}`);
    const acc = page.locator('#t-acc');
    await expect(acc.locator(`[data-role]`)).toHaveText(r.role);
    await expect(acc).toContainText(r.debt);
    await expect(acc).not.toContainText('CANARY');
    // the building's figures are open to every role
    expect((await ctx.request.get('/api/portal/finance/months')).status()).toBe(200);
    // and the fault report
    await page.goto('/portal/report');
    await expect(page.getByRole('heading', { name: 'דיווח על תקלה' })).toBeVisible();
    await ctx.close();
  });
}
