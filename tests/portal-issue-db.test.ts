import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { requireSeededAdmin } from './db-fixtures';

// The owners-portal fault report against a REAL database (WA_TEST_DATABASE_URL,
// a throwaway — never production): the reporter resolution, the INSERT and its
// snapshot, the phone kept out of the issue row, and the "ממתין לשיוך" /
// "מדיירים" filters of the issues list.
//
// Every test runs inside a transaction that is ALWAYS rolled back, so the
// fixtures — including the literal apartments 520 and 1001 the numeric-order
// rule is about — never outlive the test, even if it crashes (iron rule 12;
// the same shape as tests/sync-reconcile-db.test.ts).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
// Explicit gate: without a throwaway database these report as SKIPPED, never
// as passed — scripts/check-no-skipped-tests.mjs fails CI if any of them do.
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
let tx: PoolClient;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => tx.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await tx.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => fn(tx),
}));

const { resolvePortalReporter, insertPortalIssue } = await import('@/lib/db/portal/issueReport');
const { listIssues, getIssueById, getIssueReporterPhone } = await import('@/lib/db/issues');

const PHONE_TWO_APTS = '+972529990520';
const PHONE_A = '+972529990001';
const PHONE_B = '+972529990002';

async function apartment(n: string): Promise<void> {
  await tx.query(`insert into public.contacts (apartment_number) values ($1) on conflict (apartment_number) do nothing`, [n]);
}
async function roster(n: string, phone: string, name: string | null): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164) values ($1, $2, $3) returning id`,
    [n, name, phone],
  );
  return r.rows[0]!.id;
}
async function staffIssue(status: string, archived = false): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into public.issues (title, status, is_archived, resolution_notes) values ('DB-TEST staff', $1, $2, 'x') returning id`,
    [status, archived],
  );
  return r.rows[0]!.id;
}

const report = { location: 'חדר מדרגות', area: 'בין קומה 2 ל-3', description: 'נורה שרופה מעל המדרגות', urgency: 'medium' as const };

d('portal fault report — the real SQL', () => {
  let adminId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
    adminId = await requireSeededAdmin(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('begin');
  });
  afterEach(async () => {
    await tx.query('rollback');
    tx.release();
  });

  it('a phone with apartments 520 and 1001 reports as 520 — numeric order, not text', async () => {
    await apartment('1001');
    await apartment('520');
    await roster('1001', PHONE_TWO_APTS, 'בעל שתי דירות');
    const id520 = await roster('520', PHONE_TWO_APTS, 'בעל שתי דירות');
    // As text, '1001' < '520' — the trap this rule exists for.
    const text = await tx.query<{ a: string }>(`select min(apartment_number) as a from public.apartment_owner_phones where phone_e164 = $1`, [PHONE_TWO_APTS]);
    expect(text.rows[0]!.a).toBe('1001');

    const r = await resolvePortalReporter(PHONE_TWO_APTS);
    expect(r).toEqual({ rosterId: id520, apartmentNumber: '520', name: 'בעל שתי דירות', phoneE164: PHONE_TWO_APTS });
  });

  it('containment: a phone with apartments of two different people reports as "לא מזוהה", no apartment, no roster link', async () => {
    await apartment('1210');
    await apartment('520');
    await roster('1210', PHONE_TWO_APTS, 'רונן בדיקה');
    await roster('520', PHONE_TWO_APTS, 'טלי בדיקה');

    const reporter = await resolvePortalReporter(PHONE_TWO_APTS);
    expect(reporter).toEqual({ rosterId: null, apartmentNumber: null, name: 'לא מזוהה', phoneE164: PHONE_TWO_APTS });
    const created = await insertPortalIssue({ id: randomUUID(), report, reporter: reporter!, images: [] });
    const row = (await tx.query(
      `select reporter_contact_id, reporter_name, created_by_name, reporter_phone, reporter_apartment from public.issues where id = $1`,
      [created.id],
    )).rows[0];
    // NULL — allowed only because there is no roster link (migration 20261003095150)
    expect(row).toEqual({ reporter_contact_id: null, reporter_name: 'לא מזוהה', created_by_name: 'לא מזוהה', reporter_phone: PHONE_TWO_APTS, reporter_apartment: null });
  });

  it('the reporter is the PERSON who signed in: the name on the record that carries the phone, not the apartment owner', async () => {
    // Apartment 990790: owner field = someone else; the signed-in phone belongs
    // to an additional owner. The roster is built by the real deferred trigger.
    await tx.query(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ('990790', 'בעלת הדירה', '0529990003')`);
    const c = await tx.query<{ id: string }>(`select id from public.contacts where apartment_number = '990790'`);
    await tx.query(
      `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
       values ($1, 'owner', 'השותף שהתחבר', '052-999-0001', true, 0)`, [c.rows[0]!.id]);
    await tx.query('set constraints all immediate'); // run the deferred roster sync now
    await tx.query('set constraints all deferred');

    const reporter = await resolvePortalReporter(PHONE_A);
    expect(reporter).toMatchObject({ apartmentNumber: '990790', name: 'השותף שהתחבר', phoneE164: PHONE_A });
    // A stale label on the roster row does not win over the record.
    await tx.query(`update public.apartment_owner_phones set owner_name = 'שם ישן' where id = $1`, [reporter!.rosterId]);
    expect((await resolvePortalReporter(PHONE_A))?.name).toBe('השותף שהתחבר');
  });

  it('the CHECK: an unidentified reporter may have no apartment; an identified one must; \'\' is never an apartment', async () => {
    await apartment('990791');
    const rosterId = await roster('990791', PHONE_A, 'x');
    const insert = (contactId: string | null, apt: string | null) => tx.query(
      `insert into public.issues (title, source, reporter_contact_id, reporter_name, reporter_phone,
                                  reporter_apartment, reporter_location, ticket_number)
       values ('x', 'portal', $1, 'x', $2, $3, 'לובי', nextval('public.issues_ticket_number_seq'))`,
      [contactId, PHONE_A, apt]);
    await tx.query('savepoint s');
    await expect(insert(rosterId, null)).rejects.toMatchObject({ code: '23514' });
    await tx.query('rollback to savepoint s');
    await expect(insert(null, '')).rejects.toMatchObject({ code: '23514' });
    await tx.query('rollback to savepoint s');
    await expect(insert(null, null)).resolves.toBeDefined();
    await expect(insert(rosterId, '990791')).resolves.toBeDefined();
  });

  it('containment: the same person on two apartments (names differ only in spaces) is still identified — lowest apartment', async () => {
    await apartment('1001');
    await apartment('520');
    await roster('1001', PHONE_TWO_APTS, 'בעל  שתי דירות');
    const id520 = await roster('520', PHONE_TWO_APTS, 'בעל שתי דירות ');
    expect(await resolvePortalReporter(PHONE_TWO_APTS)).toMatchObject({ rosterId: id520, apartmentNumber: '520' });
  });

  it('an inactive roster row is never the reporter; no active row → null (no error)', async () => {
    await apartment('520');
    await apartment('1001');
    await roster('1001', PHONE_TWO_APTS, 'x');
    const r520 = await roster('520', PHONE_TWO_APTS, 'x');
    await tx.query(`update public.apartment_owner_phones set is_active = false where id = $1`, [r520]);
    expect((await resolvePortalReporter(PHONE_TWO_APTS))?.apartmentNumber).toBe('1001');
    expect(await resolvePortalReporter('+972529990999')).toBeNull();
  });

  it('an apartment with several owners records the owner of the SESSION, not the "first" one', async () => {
    await apartment('990777');
    await roster('990777', PHONE_A, 'בעלים א');
    const idB = await roster('990777', PHONE_B, 'בעלים ב');

    const reporter = await resolvePortalReporter(PHONE_B);
    expect(reporter?.rosterId).toBe(idB);
    const created = await insertPortalIssue({ id: randomUUID(), report, reporter: reporter!, images: [] });

    const row = await tx.query(
      `select reporter_contact_id, reporter_name, reporter_phone, reporter_apartment from public.issues where id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toEqual({ reporter_contact_id: idB, reporter_name: 'בעלים ב', reporter_phone: PHONE_B, reporter_apartment: '990777' });
  });

  it('the row: source=portal, mapped priority, derived title, open, no handler, no users row, a call number', async () => {
    await apartment('990778');
    await roster('990778', PHONE_A, 'מדווחת');
    const reporter = (await resolvePortalReporter(PHONE_A))!;
    const id = randomUUID();
    const created = await insertPortalIssue({ id, report, reporter, images: [`${id}/a.jpg`] });
    expect(created.id).toBe(id);
    expect(created.ticketNumber).toBeGreaterThanOrEqual(1001);

    const row = (await tx.query(
      `select source, priority, status, title, description, created_by, images, reporter_location, reporter_area,
              location_type, location_text, assigned_to_user_id, supplier_id, ticket_number
         from public.issues where id = $1`,
      [id],
    )).rows[0];
    expect(row).toMatchObject({
      source: 'portal', priority: 'high', status: 'open', title: 'דיווח דייר · חדר מדרגות',
      description: 'נורה שרופה מעל המדרגות', created_by: null, images: [`${id}/a.jpg`],
      reporter_location: 'חדר מדרגות', reporter_area: 'בין קומה 2 ל-3', ticket_number: created.ticketNumber,
      // the frozen Base44 columns are left alone (default / null)
      location_type: 'general', location_text: null, assigned_to_user_id: null, supplier_id: null,
    });
    const handlers = await tx.query(`select 1 from public.entity_assignees where entity_type = 'issue' and entity_id = $1`, [id]);
    expect(handlers.rowCount).toBe(0);
  });

  it('the snapshot survives a later change to the roster', async () => {
    await apartment('990779');
    const rid = await roster('990779', PHONE_A, 'שם בזמן הדיווח');
    const created = await insertPortalIssue({ id: randomUUID(), report, reporter: (await resolvePortalReporter(PHONE_A))!, images: [] });
    await tx.query(`update public.apartment_owner_phones set owner_name = 'שם חדש' where id = $1`, [rid]);
    await tx.query(`delete from public.apartment_owner_phones where id = $1`, [rid]);
    const row = (await tx.query(`select reporter_contact_id, reporter_name, reporter_phone from public.issues where id = $1`, [created.id])).rows[0];
    expect(row).toEqual({ reporter_contact_id: null, reporter_name: 'שם בזמן הדיווח', reporter_phone: PHONE_A });
  });

  it('the issue row (list + detail) never carries the phone; only getIssueReporterPhone reads it', async () => {
    await apartment('990780');
    await roster('990780', PHONE_A, 'x');
    const created = await insertPortalIssue({ id: randomUUID(), report, reporter: (await resolvePortalReporter(PHONE_A))!, images: [] });

    const one = await getIssueById(created.id);
    expect(one?.source).toBe('portal');
    expect(one?.reporter_apartment).toBe('990780');
    expect(one).not.toHaveProperty('reporter_phone');
    const listed = (await listIssues({ source: 'portal' })).find((i) => i.id === created.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('reporter_phone');
    expect(JSON.stringify(listed)).not.toContain(PHONE_A);
    expect(await getIssueReporterPhone(created.id)).toBe(PHONE_A);
  });

  it('a portal row without its reporter snapshot is refused by the database', async () => {
    await expect(tx.query(`insert into public.issues (title, source) values ('x', 'portal')`)).rejects.toMatchObject({ code: '23514' });
  });

  it('"ממתין לשיוך": not done (open or in_progress), not archived, with no user AND no supplier — the kanban column\'s rule', async () => {
    const openFree = await staffIssue('open');
    const inProgressFree = await staffIssue('in_progress');
    const archivedFree = await staffIssue('open', true);
    const closedFree = await staffIssue('closed');
    const withUser = await staffIssue('open');
    const withSupplier = await staffIssue('open');
    await tx.query(
      `insert into public.entity_assignees (entity_type, entity_id, assignee_type, user_id) values ('issue', $1, 'user', $2)`,
      [withUser, adminId],
    );
    const sup = await tx.query<{ id: string }>(`insert into public.suppliers (display_name) values ('DB-TEST ספק') returning id`);
    await tx.query(
      `insert into public.entity_assignees (entity_type, entity_id, assignee_type, supplier_id) values ('issue', $1, 'supplier', $2)`,
      [withSupplier, sup.rows[0]!.id],
    );

    const ids = new Set((await listIssues({ awaitingAssignment: true, includeArchived: true })).map((i) => i.id));
    expect(ids.has(openFree)).toBe(true);
    expect(ids.has(inProgressFree)).toBe(true);
    for (const id of [archivedFree, closedFree, withUser, withSupplier]) expect(ids.has(id)).toBe(false);
    for (const i of await listIssues({ awaitingAssignment: true })) expect(['open', 'in_progress']).toContain(i.status);
  });

  it('"מדיירים": source=portal returns portal reports only', async () => {
    const staff = await staffIssue('open');
    await apartment('990781');
    await roster('990781', PHONE_A, 'x');
    const portal = await insertPortalIssue({ id: randomUUID(), report, reporter: (await resolvePortalReporter(PHONE_A))!, images: [] });
    const rows = await listIssues({ source: 'portal' });
    expect(rows.some((i) => i.id === portal.id)).toBe(true);
    expect(rows.some((i) => i.id === staff)).toBe(false);
    expect(rows.every((i) => i.source === 'portal')).toBe(true);
  });
});
