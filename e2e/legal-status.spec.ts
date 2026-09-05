import { test, expect } from '@playwright/test';
import { E2E_DEBTOR_ID } from './helpers';

interface StatusRow { id: string; name: string; is_default?: boolean }
interface TenantResponse { tenant: { id: string; legal_status_id: string | null } }

// Test 2 — change a debtor's legal status and read it back, then restore the
// default so the fixture is unchanged for the next run.
test('legal status: PUT /api/debtors/:id/legal-status persists and is read back', async ({ request }) => {
  const statusesRes = await request.get('/api/statuses');
  expect(statusesRes.status()).toBe(200);
  const statuses = (await statusesRes.json()) as StatusRow[];
  const warning = statuses.find((s) => s.name === 'מכתב התראה');
  const normal = statuses.find((s) => s.is_default) ?? statuses.find((s) => s.name === 'רגיל');
  expect(warning, 'seeded status "מכתב התראה" (migration 005) missing').toBeTruthy();
  expect(normal, 'default status missing').toBeTruthy();

  const put = await request.put(`/api/debtors/${E2E_DEBTOR_ID}/legal-status`, {
    data: { status_id: warning!.id },
  });
  expect(put.status(), await put.text()).toBe(200);

  const after = (await (await request.get(`/api/debtors/${E2E_DEBTOR_ID}`)).json()) as TenantResponse;
  expect(after.tenant.legal_status_id).toBe(warning!.id);

  // restore
  const restore = await request.put(`/api/debtors/${E2E_DEBTOR_ID}/legal-status`, {
    data: { status_id: normal!.id },
  });
  expect(restore.status()).toBe(200);
  const restored = (await (await request.get(`/api/debtors/${E2E_DEBTOR_ID}`)).json()) as TenantResponse;
  expect(restored.tenant.legal_status_id).toBe(normal!.id);
});
