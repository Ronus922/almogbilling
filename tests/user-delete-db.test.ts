import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { requireSeededAdmin } from './db-fixtures';

// DELETE /api/users/[id] against a REAL database — the permanent deletion of
// a staff user (06/10/2026). The route runs as in production (guard →
// deleteUserPermanently → one transaction); only the session lookup is a fake,
// so the guard passes as the seeded e2e-admin (a super admin).
//
// What is proved here, on real rows:
//   • the account goes: the users row, its sessions, permissions, reset
//     tokens, notifications — and a login-shaped lookup finds nothing;
//   • everything the user wrote stays, with their name beside it — rows that
//     carried the name since their insert (comments, chat, reminders, folders,
//     audit) AND rows whose snapshot was still empty (an issue and a task
//     from before snapshots) get it written by the delete;
//   • the read side shows the snapshot once the live join finds no user;
//   • open issues / tasks / multi-assignee rows / pending reminders assigned
//     to the user are unassigned, and the answer counts them;
//   • the guards on real data: no session 401, an admin 403, yourself 403,
//     the last ACTIVE super admin 403, a WhatsApp-instance owner 409.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// Every row it creates is removed by the exact id it recorded; the seeded
// e2e-admin is put back exactly as found (CLAUDE.md iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
}));

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
}));
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));

const { DELETE } = await import('@/app/api/users/[id]/route');
const { writeAudit } = await import('@/lib/db/audit');
const { insertChatMessage, listChatMessagesByDebtor } = await import('@/lib/db/chatMessages');
const { createUserReminder, getUserReminderById, listUserReminders } = await import('@/lib/db/userReminders');
const { createDocumentFolder, getDocumentFolderById } = await import('@/lib/db/documents');

const E2E_DEBTOR = '00000000-0000-4000-8000-0000000e2e01';
const uniq = `udel-${Date.now()}`;
const NAME = `משתמש זמני ${uniq}`;

interface SeededAdmin { id: string; username: string; email: string; full_name: string | null; role: string; is_active: boolean }
let admin: SeededAdmin;

/** Everything created, by exact id, in delete order (content before users). */
const made = {
  comments: [] as string[], issues: [] as string[], tasks: [] as string[], assignees: [] as string[],
  reminders: [] as string[], folders: [] as string[], categories: [] as string[], invites: [] as string[],
  chat: [] as string[], audit: [] as string[], instances: [] as string[], users: [] as string[],
};

async function makeUser(role: string, suffix: string, active = true): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.users (username, email, password_hash, full_name, role, is_active)
     values ($1, $2, 'not-a-hash', $3, $4, $5) returning id`,
    [`${uniq}-${suffix}`, `${uniq}-${suffix}@billing.local`, `${NAME} ${suffix}`, role, active],
  );
  made.users.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}

function call(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/users/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
}
const asAdmin = () => { h.session = { sid: 's', user: { id: admin.id, username: admin.username, email: admin.email, full_name: admin.full_name, role: 'super_admin' } }; };

d('DELETE /api/users/[id] on a real database', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    const adminId = await requireSeededAdmin(pool);
    admin = (await pool.query<SeededAdmin>(`select id, username, email, full_name, role, is_active from public.users where id = $1`, [adminId])).rows[0]!;
  });

  afterAll(async () => {
    for (const id of made.comments) await pool.query(`delete from public.comments where id = $1`, [id]);
    for (const id of made.assignees) await pool.query(`delete from public.entity_assignees where id = $1`, [id]);
    for (const id of made.issues) await pool.query(`delete from public.issues where id = $1`, [id]);
    for (const id of made.tasks) await pool.query(`delete from public.tasks where id = $1`, [id]);
    for (const id of made.reminders) await pool.query(`delete from public.user_reminders where id = $1`, [id]);
    for (const id of made.folders) await pool.query(`delete from public.document_folders where id = $1`, [id]);
    for (const id of made.categories) await pool.query(`delete from public.reminder_categories where id = $1`, [id]);
    for (const id of made.invites) await pool.query(`delete from public.user_invites where id = $1`, [id]);
    for (const id of made.chat) await pool.query(`delete from public.chat_messages where id = $1`, [id]);
    for (const id of made.audit) await pool.query(`delete from public.audit_log where id = $1`, [id]);
    for (const id of made.instances) await pool.query(`delete from public.whatsapp_instances where id = $1`, [id]);
    for (const id of made.users) await pool.query(`delete from public.users where id = $1`, [id]);
    await pool.query(`update public.users set is_active = $2 where id = $1`, [admin.id, admin.is_active]);
    await pool.end();
  });

  it('deletes the account, keeps the content under the name, unassigns the open work', async () => {
    const uid = await makeUser('manager', 'main');
    const name = `${NAME} main`;

    // ── the account's own rows ──────────────────────────────────────────────
    await pool.query(`insert into public.sessions (id, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [`${uniq}-sess`, uid]);
    await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, 'dashboard', true, true)`, [uid]);
    await pool.query(`insert into public.password_reset_tokens (token, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [`${uniq}-tok`, uid]);
    await pool.query(`insert into public.notifications (user_id, type, title) values ($1, 'test', $2)`, [uid, uniq]);

    // ── content that already carries the name (written on insert) ──────────
    const comment = await pool.query<{ id: string }>(
      `insert into public.comments (debtor_id, apartment_number, content, author_id, author_name) values ($1, 'E2E-101', $2, $3, $4) returning id`,
      [E2E_DEBTOR, `${uniq} note`, uid, name],
    );
    made.comments.push(comment.rows[0]!.id);
    const chatId = await insertChatMessage({
      debtorId: E2E_DEBTOR, contactPhone: '0500000000', chatId: '972500000000@c.us', externalMessageId: `${uniq}-wa`,
      direction: 'sent', content: `${uniq} message`, status: 'sent', sentBy: uid,
    });
    made.chat.push(chatId!);
    const byHim = await createUserReminder({ title: `${uniq} reminder`, remind_at: new Date().toISOString(), assigned_to: admin.id }, uid);
    made.reminders.push(byHim.id);
    const folder = await createDocumentFolder({ name: `${uniq} folder` }, uid);
    made.folders.push(folder.id);
    await writeAudit({ actorUserId: uid, action: 'udel-test', entityType: 'test', entityId: uniq });
    const auditRow = (await pool.query<{ id: string; actor_name: string | null }>(`select id, actor_name from public.audit_log where action = 'udel-test' and entity_id = $1`, [uniq])).rows[0]!;
    made.audit.push(auditRow.id);
    expect(auditRow.actor_name).toBe(name); // written on insert
    expect((await getUserReminderById(byHim.id))?.created_by_name).toBe(name);
    expect((await getDocumentFolderById(folder.id))?.created_by_name).toBe(name);
    expect((await listChatMessagesByDebtor(E2E_DEBTOR)).find((m) => m.id === chatId)?.sent_by_name).toBe(name);

    // ── content from before snapshots (name column still null) + open work ──
    const issue = await pool.query<{ id: string }>(
      `insert into public.issues (title, created_by, assigned_to_user_id, status) values ($1, $2, $2, 'open') returning id`, [`${uniq} issue`, uid],
    );
    made.issues.push(issue.rows[0]!.id);
    const task = await pool.query<{ id: string }>(
      `insert into public.tasks (title, created_by, assigned_to_user_id, status) values ($1, $2, $2, 'in_progress') returning id`, [`${uniq} task`, uid],
    );
    made.tasks.push(task.rows[0]!.id);
    const closedIssue = await pool.query<{ id: string }>(
      `insert into public.issues (title, created_by, assigned_to_user_id, status) values ($1, $2, $2, 'closed') returning id`, [`${uniq} closed`, uid],
    );
    made.issues.push(closedIssue.rows[0]!.id);
    const assignee = await pool.query<{ id: string }>(
      `insert into public.entity_assignees (entity_type, entity_id, assignee_type, user_id) values ('issue', $1, 'user', $2) returning id`, [issue.rows[0]!.id, uid],
    );
    made.assignees.push(assignee.rows[0]!.id);
    const toHim = await createUserReminder({ title: `${uniq} assigned`, remind_at: new Date().toISOString(), assigned_to: uid }, admin.id);
    made.reminders.push(toHim.id);

    // ── the references that would block a plain DELETE ──────────────────────
    const category = await pool.query<{ id: string }>(`insert into public.reminder_categories (name, color, created_by) values ($1, '#3d5afe', $2) returning id`, [`${uniq} cat`, uid]);
    made.categories.push(category.rows[0]!.id);
    const invite = await pool.query<{ id: string }>(
      `insert into public.user_invites (email, full_name, role, token, invited_by, expires_at) values ($1, 'x', 'viewer', $2, $3, now() + interval '1 day') returning id`,
      [`${uniq}-invitee@billing.local`, `${uniq}-invite`, uid],
    );
    made.invites.push(invite.rows[0]!.id);

    // ── act ─────────────────────────────────────────────────────────────────
    asAdmin();
    const res = await call(uid);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, openIssuesUnassigned: 1, openTasksUnassigned: 1, openAssigneeRowsRemoved: 1, pendingRemindersUnassigned: 1 });
    expect(body.nameSnapshotsWritten).toBeGreaterThanOrEqual(3); // issue, closed issue, task
    expect(body.referencesCleared).toBeGreaterThanOrEqual(5);

    // the account is gone — and so is everything that only the account owned
    const row = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows[0] ?? null;
    expect(await row(`select 1 from public.users where id = $1`, [uid])).toBeNull();
    expect(await row(`select 1 from public.users where lower(username) = lower($1)`, [`${uniq}-main`])).toBeNull();
    expect(await row(`select 1 from public.sessions where user_id = $1`, [uid])).toBeNull();
    expect(await row(`select 1 from public.user_permissions where user_id = $1`, [uid])).toBeNull();
    expect(await row(`select 1 from public.password_reset_tokens where user_id = $1`, [uid])).toBeNull();
    expect(await row(`select 1 from public.notifications where user_id = $1`, [uid])).toBeNull();
    expect(await row(`select 1 from public.entity_assignees where id = $1`, [assignee.rows[0]!.id])).toBeNull();

    // the content stayed, under the name
    expect(await row(`select author_id, author_name from public.comments where id = $1`, [comment.rows[0]!.id])).toEqual({ author_id: null, author_name: name });
    expect(await row(`select created_by, created_by_name, assigned_to_user_id from public.issues where id = $1`, [issue.rows[0]!.id])).toEqual({ created_by: null, created_by_name: name, assigned_to_user_id: null });
    expect(await row(`select created_by, created_by_name, assigned_to_user_id from public.tasks where id = $1`, [task.rows[0]!.id])).toEqual({ created_by: null, created_by_name: name, assigned_to_user_id: null });
    expect(await row(`select created_by, created_by_name from public.user_reminders where id = $1`, [byHim.id])).toEqual({ created_by: null, created_by_name: name });
    expect(await row(`select assigned_to, created_by from public.user_reminders where id = $1`, [toHim.id])).toEqual({ assigned_to: null, created_by: admin.id });
    expect(await row(`select created_by, created_by_name from public.document_folders where id = $1`, [folder.id])).toEqual({ created_by: null, created_by_name: name });
    expect(await row(`select created_by from public.reminder_categories where id = $1`, [category.rows[0]!.id])).toEqual({ created_by: null });
    expect(await row(`select invited_by from public.user_invites where id = $1`, [invite.rows[0]!.id])).toEqual({ invited_by: null });
    expect(await row(`select sent_by, sent_by_name from public.chat_messages where id = $1`, [chatId])).toEqual({ sent_by: null, sent_by_name: name });
    expect(await row(`select actor_user_id, actor_name from public.audit_log where id = $1`, [auditRow.id])).toEqual({ actor_user_id: null, actor_name: name });

    // …and the read side shows it (the live join finds no user → the snapshot)
    expect((await getUserReminderById(byHim.id))?.created_by_name).toBe(name);
    expect((await listUserReminders({ involvingUser: admin.id })).find((r) => r.id === byHim.id)?.created_by_name).toBe(name);
    expect((await getDocumentFolderById(folder.id))?.created_by_name).toBe(name);
    expect((await listChatMessagesByDebtor(E2E_DEBTOR)).find((m) => m.id === chatId)?.sent_by_name).toBe(name);

    // the deletion itself is on record, by the admin, with the counts
    const audit = (await pool.query<{ id: string; actor_user_id: string; actor_name: string; metadata: Record<string, unknown> }>(
      `select id, actor_user_id, actor_name, metadata from public.audit_log where action = 'deleted' and entity_type = 'user' and entity_id = $1`, [uid],
    )).rows;
    expect(audit).toHaveLength(1);
    made.audit.push(audit[0]!.id);
    expect(audit[0]!.actor_user_id).toBe(admin.id);
    expect(audit[0]!.metadata).toMatchObject({ username: `${uniq}-main`, full_name: name, role: 'manager', was_active: true, openIssuesUnassigned: 1, openTasksUnassigned: 1 });
  });

  it('a disabled user is deleted the same way', async () => {
    const uid = await makeUser('viewer', 'disabled', false);
    asAdmin();
    expect((await call(uid)).status).toBe(200);
    expect((await pool.query(`select 1 from public.users where id = $1`, [uid])).rowCount).toBe(0);
    made.audit.push(...(await pool.query<{ id: string }>(`select id from public.audit_log where action = 'deleted' and entity_type = 'user' and entity_id = $1`, [uid])).rows.map((r) => r.id));
  });

  it('no session → 401; an admin → 403; yourself → 403 — the user stays', async () => {
    const uid = await makeUser('manager', 'guarded');
    h.session = null;
    expect((await call(uid)).status).toBe(401);
    h.session = { sid: 's', user: { id: admin.id, username: admin.username, email: admin.email, full_name: admin.full_name, role: 'admin' } };
    expect((await call(uid)).status).toBe(403);
    h.session = { sid: 's', user: { id: uid, username: `${uniq}-guarded`, email: 'x', full_name: null, role: 'super_admin' } };
    expect((await call(uid)).status).toBe(403);
    expect((await pool.query(`select 1 from public.users where id = $1`, [uid])).rowCount).toBe(1);
  });

  it('the last ACTIVE super admin cannot be deleted; once another is active, it can', async () => {
    const other = await makeUser('super_admin', 'sa');
    asAdmin();
    // e2e-admin steps aside for a moment → `other` is the last active super admin
    await pool.query(`update public.users set is_active = false where id = $1`, [admin.id]);
    try {
      const res = await call(other);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/הסופר אדמין הפעיל האחרון/);
    } finally {
      await pool.query(`update public.users set is_active = $2 where id = $1`, [admin.id, admin.is_active]);
    }
    expect((await call(other)).status).toBe(200);
    made.audit.push(...(await pool.query<{ id: string }>(`select id from public.audit_log where action = 'deleted' and entity_type = 'user' and entity_id = $1`, [other])).rows.map((r) => r.id));
  });

  it('the nominal owner of a WhatsApp instance → 409 until the instance is moved', async () => {
    const owner = await makeUser('admin', 'wa');
    const inst = await pool.query<{ id: string }>(
      `insert into public.whatsapp_instances (user_id, display_name, green_instance_id, green_token_enc) values ($1, $2, $3, '{}'::jsonb) returning id`,
      [owner, `${uniq} instance`, `${uniq}-green`],
    );
    made.instances.push(inst.rows[0]!.id);
    asAdmin();
    const res = await call(owner);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/WhatsApp/);
    expect((await pool.query(`select 1 from public.users where id = $1`, [owner])).rowCount).toBe(1);
    expect((await pool.query(`select 1 from public.whatsapp_instances where id = $1`, [inst.rows[0]!.id])).rowCount).toBe(1);

    await pool.query(`delete from public.whatsapp_instances where id = $1`, [inst.rows[0]!.id]);
    expect((await call(owner)).status).toBe(200);
    made.audit.push(...(await pool.query<{ id: string }>(`select id from public.audit_log where action = 'deleted' and entity_type = 'user' and entity_id = $1`, [owner])).rows.map((r) => r.id));
  });
});
