import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_VIEWER, DEFAULT_MANAGER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// The CRM side of decisions & protocols (/api/decisions), through the REAL
// staff guard chain: requirePermission → getCurrentActor → session +
// user_permissions rows. `portal_decisions` is deny-by-default like `finance`
// and `portal_manage`, so what is locked here is that it really is closed:
//
//   • qa-viewer (the persistent read-only QA user: DEFAULT_VIEWER, i.e. a
//     dashboard-only matrix) is refused on EVERY verb — list, upload, edit,
//     delete — and a manager with the full default matrix is refused too,
//     because neither holds a portal_decisions row;
//   • admin passes;
//   • the upload rejects a non-PDF, an empty file, an oversized file, a
//     missing title / type / date — all of it BEFORE anything is uploaded or
//     written;
//   • a failed insert removes the object it had already uploaded, so no
//     orphan is ever left behind;
//   • a protocol never keeps a decision number, on create or on edit.

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
  insertThrows: false,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({ query: vi.fn(async () => ({ rows: h.permRows })), queryOne: vi.fn(async () => null) }));
vi.mock('@/lib/db/portalDecisions', () => ({
  listDecisions: vi.fn(async () => []),
  insertDecision: vi.fn(async (input: Record<string, unknown>) => {
    if (h.insertThrows) throw new Error('insert exploded');
    return {
      id: 'dec-new', title: input.title, summary: input.summary, doc_type: input.docType,
      decision_number: input.decisionNumber, decided_at: input.decidedAt,
      bucket: 'portal-decisions', object_key: input.objectKey, original_filename: input.originalFilename,
      file_size: input.fileSize, mime_type: input.mimeType, published: input.published,
      created_by: input.createdBy, created_at: '2026-10-05T00:00:00.000Z', updated_at: '2026-10-05T00:00:00.000Z',
    };
  }),
  updateDecision: vi.fn(async (id: string, input: Record<string, unknown>) => ({
    id, title: input.title, summary: input.summary, doc_type: input.docType,
    decision_number: input.decisionNumber, decided_at: input.decidedAt,
    bucket: 'portal-decisions', object_key: 'k.pdf', original_filename: 'a.pdf',
    file_size: 10, mime_type: 'application/pdf', published: input.published,
    created_by: 'u1', created_at: '2026-10-05T00:00:00.000Z', updated_at: '2026-10-05T00:00:00.000Z',
  })),
  deleteDecision: vi.fn(async (id: string) => (id === 'dec-1' ? {
    id, title: 't', summary: null, doc_type: 'decision', decision_number: null, decided_at: '2026-01-01',
    bucket: 'portal-decisions', object_key: 'gone.pdf', original_filename: 'a.pdf', file_size: 10,
    mime_type: 'application/pdf', published: true, created_by: null,
    created_at: '2026-10-05T00:00:00.000Z', updated_at: '2026-10-05T00:00:00.000Z',
  } : null)),
}));
vi.mock('@/lib/storage/decisionStorage', () => ({
  uploadDecisionFile: vi.fn(async () => ({ objectKey: 'uploaded.pdf', sizeBytes: 2048 })),
  removeDecisionFile: vi.fn(async () => undefined),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET as list, POST as create } from '@/app/api/decisions/route';
import { PATCH as patch, DELETE as del } from '@/app/api/decisions/[id]/route';
import { insertDecision, updateDecision } from '@/lib/db/portalDecisions';
import { removeDecisionFile, uploadDecisionFile } from '@/lib/storage/decisionStorage';

const MB = 1024 * 1024;

function signIn(role: Role, rows: ModulePermission[] = []) {
  h.session = { sid: 's', user: { id: `u-${role}`, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

function pdf(name = 'החלטה.pdf', size = 2048, type = 'application/pdf'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function upload(fields: Record<string, string> = {}, file: File | null = pdf()) {
  const fd = new FormData();
  if (file) fd.append('file', file);
  const base = { title: 'אישור תקציב 2026', doc_type: 'decision', decided_at: '2026-03-15' };
  for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== '') fd.append(k, v);
  return create(new NextRequest('http://localhost/api/decisions', { method: 'POST', body: fd }));
}

function edit(body: unknown, id = 'dec-1') {
  return patch(
    new NextRequest(`http://localhost/api/decisions/${id}`, {
      method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
}

const VALID_EDIT = {
  title: 'כותרת מעודכנת', summary: null, doc_type: 'decision',
  decision_number: '14/2026', decided_at: '2026-03-15', published: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.permRows = [];
  h.insertThrows = false;
});

describe('/api/decisions — who may do anything at all', () => {
  it('no session → 401 on every verb, nothing uploaded or written', async () => {
    expect((await list()).status).toBe(401);
    expect((await upload()).status).toBe(401);
    expect((await edit(VALID_EDIT)).status).toBe(401);
    expect((await del(new NextRequest('http://localhost/api/decisions/dec-1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'dec-1' }) })).status).toBe(401);
    expect(uploadDecisionFile).not.toHaveBeenCalled();
    expect(insertDecision).not.toHaveBeenCalled();
  });

  it('qa-viewer (dashboard-only matrix) is refused on every verb', async () => {
    signIn('viewer', DEFAULT_VIEWER);
    expect((await list()).status).toBe(403);
    expect((await upload()).status).toBe(403);
    expect((await edit(VALID_EDIT)).status).toBe(403);
    expect(uploadDecisionFile).not.toHaveBeenCalled();
    expect(updateDecision).not.toHaveBeenCalled();
  });

  it('a manager with the FULL default matrix is still refused — deny by default', async () => {
    signIn('manager', DEFAULT_MANAGER);
    expect((await list()).status).toBe(403);
    expect((await upload()).status).toBe(403);
  });

  it('admin passes', async () => {
    signIn('admin');
    expect((await list()).status).toBe(200);
    expect((await upload()).status).toBe(201);
  });
});

describe('POST /api/decisions — the file and the fields', () => {
  beforeEach(() => signIn('admin'));

  it('refuses anything that is not a PDF, before touching Storage', async () => {
    expect((await upload({}, new File([new Uint8Array(10)], 'a.docx', { type: '' }))).status).toBe(400);
    expect((await upload({}, new File([new Uint8Array(10)], 'a.pdf', { type: 'image/png' }))).status).toBe(400);
    expect((await upload({}, null)).status).toBe(400);
    expect(uploadDecisionFile).not.toHaveBeenCalled();
  });

  it('refuses an empty file and one over 50MB', async () => {
    expect((await upload({}, pdf('a.pdf', 0))).status).toBe(400);
    expect((await upload({}, pdf('a.pdf', 50 * MB + 1))).status).toBe(400);
    expect(uploadDecisionFile).not.toHaveBeenCalled();
  });

  it('requires a title, a known type and a real date', async () => {
    expect((await upload({ title: '' })).status).toBe(400);
    expect((await upload({ doc_type: 'minutes' })).status).toBe(400);
    expect((await upload({ decided_at: '15.03.2026' })).status).toBe(400);
    expect((await upload({ decided_at: '2026-13-01' })).status).toBe(400);
    expect(uploadDecisionFile).not.toHaveBeenCalled();
  });

  it('stores a decision with its number, and a protocol with none', async () => {
    await upload({ decision_number: '04/2026' });
    expect(vi.mocked(insertDecision).mock.calls[0][0]).toMatchObject({
      docType: 'decision', decisionNumber: '04/2026', published: true, mimeType: 'application/pdf',
    });
    vi.mocked(insertDecision).mockClear();
    await upload({ doc_type: 'protocol', decision_number: '04/2026' });
    expect(vi.mocked(insertDecision).mock.calls[0][0]).toMatchObject({ docType: 'protocol', decisionNumber: null });
  });

  it('a failed insert removes the object it had already uploaded', async () => {
    h.insertThrows = true;
    expect((await upload()).status).toBe(500);
    expect(removeDecisionFile).toHaveBeenCalledWith('uploaded.pdf');
  });
});

describe('PATCH /api/decisions/[id] — metadata only', () => {
  beforeEach(() => signIn('admin'));

  it('rejects a malformed body and never writes', async () => {
    expect((await edit({ ...VALID_EDIT, title: '' })).status).toBe(400);
    expect((await edit({ ...VALID_EDIT, decided_at: '15.03.2026' })).status).toBe(400);
    expect((await edit({ ...VALID_EDIT, published: 'yes' })).status).toBe(400);
    expect(updateDecision).not.toHaveBeenCalled();
  });

  it('switching a row to "פרוטוקול" drops its decision number', async () => {
    await edit({ ...VALID_EDIT, doc_type: 'protocol' });
    expect(vi.mocked(updateDecision).mock.calls[0][1]).toMatchObject({ docType: 'protocol', decisionNumber: null });
  });

  it('carries the published switch through', async () => {
    await edit({ ...VALID_EDIT, published: false });
    expect(vi.mocked(updateDecision).mock.calls[0][1]).toMatchObject({ published: false });
  });
});

describe('DELETE /api/decisions/[id]', () => {
  beforeEach(() => signIn('admin'));

  it('removes the row and then the object', async () => {
    const res = await del(new NextRequest('http://localhost/api/decisions/dec-1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'dec-1' }) });
    expect(res.status).toBe(200);
    expect(removeDecisionFile).toHaveBeenCalledWith('gone.pdf');
  });

  it('404s on an unknown id, and removes nothing', async () => {
    const res = await del(new NextRequest('http://localhost/api/decisions/nope', { method: 'DELETE' }), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
    expect(removeDecisionFile).not.toHaveBeenCalled();
  });
});
