import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MANAGER, DEFAULT_VIEWER, DEFAULT_WORKER, type ModulePermission, type Role } from '@/lib/permissions/constants';

// Purchasing has two matrix keys — purchasing_requests and purchasing_orders —
// with a view / edit level each (24/10/2026). This locks the route layer through
// the REAL guard chain (requirePurchasing* → getCurrentActor → session +
// user_permissions rows): every staff route answers 401 with no session and 403
// to a manager holding the whole default matrix, to a viewer and to a field
// worker; an admin gets in on both keys; a per-user grant opens exactly its key
// at exactly its level; the letterhead settings are admin and up.

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

describe('purchasing permissions', () => {
  beforeEach(() => { h.session = null; h.permRows = []; });

  const body = (doc_type: 'rfq' | 'po') => JSON.stringify({
    doc_type, doc_date: '2026-10-24', title: 'נושא', supplier_name: 'ספק', due_date: '2099-01-01',
    lines: [{ description: 'שורה', quantity: 1, unit_price: 5 }],
  });
  const post = (doc_type: 'rfq' | 'po') =>
    documents.POST(new NextRequest('http://localhost/x', { method: 'POST', body: body(doc_type), headers: { 'content-type': 'application/json' } }));
  const list = (type: 'rfq' | 'po') => documents.GET(r('GET', `/x?type=${type}`));
  const grant = (module: string, canView: boolean, canEdit: boolean): ModulePermission[] => [{ module, canView, canEdit }];

  it.each(calls)('%s → 401 without a session', async (_n, call) => {
    expect((await call()).status).toBe(401);
  });

  it.each(calls)('%s → 403 for a manager with the full default matrix', async (_n, call) => {
    signIn('manager', DEFAULT_MANAGER);
    expect((await call()).status).toBe(403);
  });

  it.each(calls)('%s → 403 for a viewer', async (_n, call) => {
    signIn('viewer', DEFAULT_VIEWER);
    expect((await call()).status).toBe(403);
  });

  it.each(calls)('%s → 403 for a field worker', async (_n, call) => {
    signIn('cleaner', DEFAULT_WORKER);
    expect((await call()).status).toBe(403);
  });

  it('an admin and a super admin pass the guards on both keys', async () => {
    for (const role of ['admin', 'super_admin'] as const) {
      signIn(role);
      expect((await suppliers.GET()).status).not.toBe(403);
      expect((await list('rfq')).status).toBe(200);
      expect((await list('po')).status).toBe(200);
      expect((await post('po')).status).not.toBe(403);
      expect((await post('rfq')).status).not.toBe(403);
      expect((await company.PUT(r('PUT'))).status).not.toBe(403); // settings: admin and up
      const res = await proxy.GET(r('GET'), { params: Promise.resolve({ bucket: 'purchasing-files', path: [`${ID}.pdf`] }) });
      expect(res.status).toBe(404); // guard passed; the (mocked) object does not exist
    }
  });

  it('a request-only grant reads and writes requests, and is refused on orders', async () => {
    signIn('manager', grant('purchasing_requests', true, true));
    expect((await list('rfq')).status).toBe(200);
    expect((await list('po')).status).toBe(403);
    expect((await post('rfq')).status).not.toBe(403);
    expect((await post('po')).status).toBe(403);
    expect((await suppliers.GET()).status).not.toBe(403); // shared helpers: any purchasing view
    expect((await company.GET()).status).not.toBe(403);
  });

  it('an order-only grant is the mirror image', async () => {
    signIn('manager', grant('purchasing_orders', true, true));
    expect((await list('po')).status).toBe(200);
    expect((await list('rfq')).status).toBe(403);
    expect((await post('po')).status).not.toBe(403);
    expect((await post('rfq')).status).toBe(403);
    // Quotes and the winner belong to requests only.
    expect((await winner.PUT(r('PUT'), ctx)).status).toBe(403);
    expect((await quotes.DELETE(r('DELETE', `/x?supplier_id=${ID}`), ctx)).status).toBe(403);
  });

  it('view-only reads but never writes', async () => {
    signIn('manager', grant('purchasing_requests', true, false));
    expect((await list('rfq')).status).toBe(200);
    expect((await post('rfq')).status).toBe(403);
    expect((await documentById.PATCH(r('PATCH'), ctx)).status).toBe(403);
    expect((await documentById.DELETE(r('DELETE'), ctx)).status).toBe(403);
    expect((await send.POST(r('POST'), ctx)).status).toBe(403);
    expect((await winner.PUT(r('PUT'), ctx)).status).toBe(403);
    expect((await preview.POST(r('POST'))).status).toBe(403);
    expect((await fileById.DELETE(r('DELETE'), ctx)).status).toBe(403);
  });

  it('the letterhead settings are admin and up — no grant opens them', async () => {
    signIn('manager', [
      ...grant('purchasing_requests', true, true), ...grant('purchasing_orders', true, true),
    ]);
    expect((await company.PUT(r('PUT'))).status).toBe(403);
    expect((await companyImage.POST(r('POST'))).status).toBe(403);
    expect((await companyImage.DELETE(r('DELETE', '/x?kind=logo'))).status).toBe(403);
    expect((await company.GET()).status).not.toBe(403); // reading it (the form needs the numbering) is any purchasing view
  });

  it('the old single key opens nothing', async () => {
    signIn('manager', grant('purchasing', true, true));
    expect((await list('rfq')).status).toBe(403);
    expect((await suppliers.GET()).status).toBe(403);
  });
});
