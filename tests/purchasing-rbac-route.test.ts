import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MANAGER, DEFAULT_VIEWER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// Purchasing is SUPER ADMIN ONLY by default, in all three layers. This locks
// the route layer through the REAL guard chain (requirePermission →
// getCurrentActor → session + user_permissions rows): every staff route of the
// module answers 401 with no session and 403 to an admin, to a manager holding
// the whole default matrix and to a viewer — and only a super admin gets in.

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async () => ({ rows: h.permRows, rowCount: 0 })),
  queryOne: vi.fn(async () => null),
  withTransaction: vi.fn(async () => { throw new Error('should not reach the database'); }),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/storage/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/storage/server')>()),
  getObjectStream: vi.fn(async () => null),
}));

const company = await import('@/app/api/purchasing/company/route');
const companyImage = await import('@/app/api/purchasing/company/image/route');
const documents = await import('@/app/api/purchasing/documents/route');
const documentById = await import('@/app/api/purchasing/documents/[id]/route');
const pdf = await import('@/app/api/purchasing/documents/[id]/pdf/route');
const send = await import('@/app/api/purchasing/documents/[id]/send/route');
const docFiles = await import('@/app/api/purchasing/documents/[id]/files/route');
const quotes = await import('@/app/api/purchasing/documents/[id]/quotes/route');
const preview = await import('@/app/api/purchasing/preview/route');
const winner = await import('@/app/api/purchasing/documents/[id]/winner/route');
const fileById = await import('@/app/api/purchasing/files/[fileId]/route');
const suggestions = await import('@/app/api/purchasing/suggestions/route');
const suppliers = await import('@/app/api/purchasing/suppliers/route');
const proxy = await import('@/app/api/files/[bucket]/[...path]/route');

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id: ID, supplierId: ID, fileId: ID }) };
const r = (method: string, url = '/x') => new NextRequest(`http://localhost${url}`, { method });

type Call = [string, () => Promise<Response>];
const calls: Call[] = [
  ['GET company', () => company.GET()],
  ['PUT company', () => company.PUT(r('PUT'))],
  ['POST company/image', () => companyImage.POST(r('POST'))],
  ['DELETE company/image', () => companyImage.DELETE(r('DELETE', '/x?kind=logo'))],
  ['GET documents', () => documents.GET(r('GET', '/x?type=rfq'))],
  ['POST documents', () => documents.POST(r('POST'))],
  ['GET document', () => documentById.GET(r('GET'), ctx)],
  ['PATCH document', () => documentById.PATCH(r('PATCH'), ctx)],
  ['DELETE document', () => documentById.DELETE(r('DELETE'), ctx)],
  ['GET pdf', () => pdf.GET(r('GET'), ctx)],
  ['POST send', () => send.POST(r('POST'), ctx)],
  ['POST document files', () => docFiles.POST(r('POST'), ctx)],
  ['POST preview', () => preview.POST(r('POST'))],
  ['DELETE quotes', () => quotes.DELETE(r('DELETE', `/x?supplier_id=${ID}`), ctx)],
  ['PUT winner', () => winner.PUT(r('PUT'), ctx)],
  ['DELETE file', () => fileById.DELETE(r('DELETE'), ctx)],
  ['GET suggestions', () => suggestions.GET(r('GET'))],
  ['GET suppliers', () => suppliers.GET()],
  ['GET /api/files/purchasing-files', () => proxy.GET(
    r('GET'), { params: Promise.resolve({ bucket: 'purchasing-files', path: [`${ID}.pdf`] }) },
  )],
];

function signIn(role: Role, rows: ModulePermission[] = []) {
  h.session = { sid: 's', user: { id: `u-${role}`, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((p) => ({ module: p.module, can_view: p.canView, can_edit: p.canEdit }));
}

describe('purchasing is super admin only', () => {
  beforeEach(() => { h.session = null; h.permRows = []; });

  it.each(calls)('%s → 401 without a session', async (_n, call) => {
    expect((await call()).status).toBe(401);
  });

  it.each(calls)('%s → 403 for an admin', async (_n, call) => {
    signIn('admin');
    expect((await call()).status).toBe(403);
  });

  it.each(calls)('%s → 403 for a manager with the full default matrix', async (_n, call) => {
    signIn('manager', DEFAULT_MANAGER);
    expect((await call()).status).toBe(403);
  });

  it.each(calls)('%s → 403 for a viewer', async (_n, call) => {
    signIn('viewer', DEFAULT_VIEWER);
    expect((await call()).status).toBe(403);
  });

  it('a super admin passes the guard (and is only stopped later by the missing body / object)', async () => {
    signIn('super_admin');
    expect((await suppliers.GET()).status).not.toBe(401);
    expect((await suppliers.GET()).status).not.toBe(403);
    const res = await proxy.GET(r('GET'), { params: Promise.resolve({ bucket: 'purchasing-files', path: [`${ID}.pdf`] }) });
    expect(res.status).toBe(404); // guard passed; the (mocked) object does not exist
  });

  it('a manager holding an explicit purchasing row is let in — a super admin may grant it per user', async () => {
    signIn('manager', [{ module: 'purchasing', canView: true, canEdit: false }]);
    expect((await suppliers.GET()).status).not.toBe(403);
    // …but view-only cannot write.
    expect((await documents.POST(r('POST'))).status).toBe(403);
  });
});
