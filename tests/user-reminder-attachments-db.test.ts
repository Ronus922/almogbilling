import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { requireSeededAdmin } from './db-fixtures';

// Reminder description + attachments (05/10/2026) against a REAL database
// (WA_TEST_DATABASE_URL, a throwaway — never production): the description
// column and its 1000-character CHECK, and the staged → linked lifecycle of
// user_reminder_attachments (the fin_documents pattern): only the uploader's
// own staged rows link, a linked row never moves, a GC-stamped row is gone,
// archiving keeps the files and only a hard delete cascades.
//
// Every test runs inside a transaction that is ALWAYS rolled back (iron rule
// 12; same shape as tests/issues-board-move-db.test.ts). No Storage is touched —
// the rows carry made-up object keys.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
let tx: PoolClient;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => tx.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await tx.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => fn(tx),
}));

const { createUserReminder, getUserReminderById, updateUserReminder, softDeleteUserReminder } =
  await import('@/lib/db/userReminders');
const {
  insertStagedAttachment, linkAttachments, listReminderAttachments, deleteStagedAttachment,
  deleteReminderAttachment, getAttachment, toAttachmentView,
} = await import('@/lib/db/userReminderAttachments');

d('reminder description + attachments — the real SQL', () => {
  let adminId = '';

  const reminder = (title = 'DB-TEST reminder', description?: string | null) =>
    createUserReminder({ title, remind_at: '2026-10-05T06:00:00.000Z', description }, adminId);
  const staged = (uploadedBy: string | null = adminId, name = 'דף חשבון.pdf') =>
    insertStagedAttachment({
      uploadedBy: uploadedBy as string, objectKey: `${randomUUID()}.pdf`, originalName: name,
      mime: 'application/pdf', size: 284 * 1024,
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 2 });
    pool.on('error', () => undefined);
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

  it('the description is stored, read back, cleared — and capped at 1000 characters', async () => {
    const r = await reminder('DB-TEST described', 'שורה\nשנייה');
    expect(r.description).toBe('שורה\nשנייה');
    expect((await getUserReminderById(r.id))?.description).toBe('שורה\nשנייה');

    const cleared = await updateUserReminder(r.id, { description: null });
    expect(cleared?.description).toBeNull();
    // A status-only update leaves it alone.
    await updateUserReminder(r.id, { description: 'נשאר' });
    expect((await updateUserReminder(r.id, { status: 'done' }))?.description).toBe('נשאר');

    await tx.query('savepoint too_long');
    await expect(updateUserReminder(r.id, { description: 'א'.repeat(1001) })).rejects.toMatchObject({ code: '23514' });
    await tx.query('rollback to savepoint too_long');
    expect((await updateUserReminder(r.id, { description: 'א'.repeat(1000) }))?.description).toHaveLength(1000);
  });

  it('a staged file links on save and is listed with its proxy url', async () => {
    const r = await reminder();
    const a = await staged();
    expect(a.reminder_id).toBeNull();

    expect(await linkAttachments(r.id, [a.id], adminId)).toBe(1);
    const list = await listReminderAttachments(r.id);
    expect(list.map((x) => x.id)).toEqual([a.id]);
    const view = toAttachmentView(list[0]!);
    expect(view.url).toBe(`/api/files/reminder-attachments/${encodeURIComponent(a.object_key)}`);
    expect(view.original_name).toBe('דף חשבון.pdf');
    expect(view.size).toBe(284 * 1024);
    expect(Number.isNaN(Date.parse(view.created_at))).toBe(false);
  });

  it('only the uploader\'s own staged rows link; a linked row never moves to another reminder', async () => {
    const r1 = await reminder('DB-TEST one');
    const r2 = await reminder('DB-TEST two');
    const foreign = await staged(null); // not uploaded by this actor
    const mine = await staged();

    expect(await linkAttachments(r1.id, [foreign.id, mine.id], adminId)).toBe(1);
    expect((await getAttachment(foreign.id))?.reminder_id).toBeNull();

    expect(await linkAttachments(r2.id, [mine.id], adminId)).toBe(0);
    expect((await getAttachment(mine.id))?.reminder_id).toBe(r1.id);
  });

  it('a row the Storage GC stamped is neither linked nor listed', async () => {
    const r = await reminder();
    const gone = await staged();
    await tx.query(`update public.user_reminder_attachments set object_deleted_at = now() where id = $1`, [gone.id]);
    expect(await linkAttachments(r.id, [gone.id], adminId)).toBe(0);

    const kept = await staged();
    await linkAttachments(r.id, [kept.id], adminId);
    await tx.query(`update public.user_reminder_attachments set object_deleted_at = now() where id = $1`, [kept.id]);
    expect(await listReminderAttachments(r.id)).toEqual([]);
  });

  it('delete: a staged row only by its uploader, a linked row only through its reminder', async () => {
    const r = await reminder();
    const foreign = await staged(null);
    expect(await deleteStagedAttachment(foreign.id, adminId)).toBeNull();

    const mine = await staged();
    expect((await deleteStagedAttachment(mine.id, adminId))?.id).toBe(mine.id);

    const linked = await staged();
    await linkAttachments(r.id, [linked.id], adminId);
    expect(await deleteStagedAttachment(linked.id, adminId)).toBeNull(); // no longer staged
    expect(await deleteReminderAttachment(linked.id, randomUUID())).toBeNull(); // wrong reminder
    expect((await deleteReminderAttachment(linked.id, r.id))?.id).toBe(linked.id);
    expect(await getAttachment(linked.id)).toBeNull();
  });

  it('archiving keeps the files; only a hard delete cascades', async () => {
    const r = await reminder();
    const a = await staged();
    await linkAttachments(r.id, [a.id], adminId);

    expect(await softDeleteUserReminder(r.id)).toBe(true);
    expect((await listReminderAttachments(r.id)).map((x) => x.id)).toEqual([a.id]);

    await tx.query(`delete from public.user_reminders where id = $1`, [r.id]);
    expect(await getAttachment(a.id)).toBeNull();
  });
});
