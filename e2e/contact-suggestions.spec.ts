import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

// The Bllink approval queue, through the screen (29/09/2026).
//
// The sync no longer overwrites a resident field it disagrees with — it files a
// suggestion and OURS STANDS until someone decides. What is pinned here is the
// part a person actually sees: the count on the button, the row in the panel,
// and that approving writes the value while rejecting leaves it exactly as it
// was.
//
// The suggestions are produced by the REAL entry point, public.contact_sync_
// ingest — the same function the nightly sync calls — so a change in the rules
// shows up here rather than in a hand-written fixture.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

// Apartments this file creates, removed by these exact numbers (iron rule 12).
// Numeric because the registry keys on digits only.
const APPROVE_APT = '990101';
const REJECT_APT = '990102';
const APTS = [APPROVE_APT, REJECT_APT];

const OURS = '0541111111';
const THEIRS = '052-222-2222';

async function cleanup() {
  // contact_sync_suggestions, contact_field_sources and apartment_owner_phones
  // all cascade from contacts.
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

test.beforeAll(async () => {
  await cleanup();
  await pool.query(
    `insert into public.contacts (apartment_number, owner_name, owner_phone, source)
     values ($1, 'בעלים קיים', $3, 'manual'), ($2, 'בעלים קיים', $3, 'manual')`,
    [APPROVE_APT, REJECT_APT, OURS],
  );
  // One Bllink report that disagrees with both.
  await pool.query(
    `select public.contact_sync_ingest($1::text[], $2::text[], $3::text[])`,
    [APTS, ['owner_phone', 'owner_phone'], [THEIRS, THEIRS]],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function ownerPhone(apt: string): Promise<string | null> {
  const r = await pool.query<{ owner_phone: string | null }>(
    `select owner_phone from public.contacts where apartment_number = $1`, [apt]);
  return r.rows[0]?.owner_phone ?? null;
}

test('the queue: a conflict is offered, approving writes it, rejecting keeps ours', async ({ page }) => {
  await page.goto('/contacts');

  // The button carries the count and is not drawn at all when nothing waits.
  const queueButton = page.getByRole('button', { name: /הצעות מבלינק/ });
  await expect(queueButton).toBeVisible();
  await expect(queueButton).toContainText(/\d+ הצעות מבלינק/);

  await queueButton.click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'הצעות מבלינק' })).toBeVisible();

  // Ours on the right, struck through; Bllink's beside it. Addressed by the
  // row's own key — a text filter catches the panel that CONTAINS the row too.
  const row = panel.locator(`[data-suggestion="${APPROVE_APT}:owner_phone"]`);
  await expect(row).toContainText('טלפון בעלים');
  await expect(row).toContainText(OURS);
  await expect(row).toContainText(THEIRS);

  // ── approve ───────────────────────────────────────────────────────────────
  await row.getByRole('button', { name: 'אשר' }).click();
  await expect(panel.locator(`[data-suggestion="${APPROVE_APT}:owner_phone"]`)).toHaveCount(0);
  await expect.poll(() => ownerPhone(APPROVE_APT)).toBe(THEIRS);

  // ── reject ────────────────────────────────────────────────────────────────
  const rejectRow = panel.locator(`[data-suggestion="${REJECT_APT}:owner_phone"]`);
  await rejectRow.getByRole('button', { name: 'דחה' }).click();
  await expect(panel.locator(`[data-suggestion="${REJECT_APT}:owner_phone"]`)).toHaveCount(0);
  // Ours is untouched — that is the whole promise of the mechanism.
  await expect.poll(() => ownerPhone(REJECT_APT)).toBe(OURS);

  // And a rejected value does not come back on the next sync.
  await pool.query(
    `select public.contact_sync_ingest($1::text[], $2::text[], $3::text[])`,
    [[REJECT_APT], ['owner_phone'], [THEIRS]],
  );
  const still = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.contact_sync_suggestions
      where apartment_number = $1 and status = 'pending'`, [REJECT_APT]);
  expect(still.rows[0]!.n).toBe('0');
});

// One phone on several apartments (a management company, a multi-unit
// landlord) resolves as ONE group, one click — not row by row
// (17/10/2026, "פישוט גישת פורטל").
const GROUP_APT1 = '990201';
const GROUP_APT2 = '990202';
const GROUP_APTS = [GROUP_APT1, GROUP_APT2];
const GROUP_PHONE = '+972501234567';

test.describe('one phone, several apartments — grouped', () => {
  test.beforeAll(async () => {
    await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [GROUP_APTS]);
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, source) values ($1, 'בעלים 1', 'manual'), ($2, 'בעלים 2', 'manual')`,
      [GROUP_APT1, GROUP_APT2],
    );
    await pool.query(
      `insert into public.contact_sync_suggestions
         (apartment_number, field, current_value, proposed_value, source, phone_e164, person_role, person_name)
       values
         ($1, 'portal_link', null, $3, 'bllink', $3, 'owner', 'כרמל אפרטמנטס'),
         ($2, 'portal_link', null, $3, 'bllink', $3, 'owner', 'כרמל אפרטמנטס')`,
      [GROUP_APT1, GROUP_APT2, GROUP_PHONE],
    );
  });
  test.afterAll(async () => {
    await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [GROUP_APTS]);
  });

  test('one "שייך לכל הדירות" click closes both apartments at once, permanently', async ({ page }) => {
    await page.goto('/contacts');
    await page.getByRole('button', { name: /הצעות מבלינק/ }).click();
    const panel = page.getByRole('dialog');
    const group = panel.locator(`[data-suggestion-group="portal_link:${GROUP_PHONE}"]`);
    await expect(group).toBeVisible();
    await expect(group).toContainText('כרמל אפרטמנטס');
    await expect(group).toContainText(`דירה ${GROUP_APT1}`);
    await expect(group).toContainText(`דירה ${GROUP_APT2}`);

    await group.getByRole('button', { name: /שייך לכל הדירות/ }).click();
    await expect(group).toHaveCount(0);

    // Both apartments are gone from the queue at once — resolved in the
    // database, not just hidden client-side.
    const left = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.contact_sync_suggestions
        where apartment_number = any($1::text[]) and status = 'pending'`, [GROUP_APTS]);
    expect(left.rows[0]!.n).toBe('0');
  });
});
