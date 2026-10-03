import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// F9 — every file served to a signed-in user leaves ONE `file_viewed` row in
// the central audit_log, through the same writeAudit the upload/delete rows use.
//   • the row carries the user (id + name snapshot), the file, its parent
//     entity and the client IP;
//   • the same user opening the same file again inside 10 minutes is NOT a
//     new row (a refreshing preview stays one view); after the window it is;
//   • a failing audit_log never withholds the file — the proxy still answers
//     200 with the bytes and the failure goes to the server log;
//   • a denied request logs nothing.
// The DB is an in-memory audit table behind the mocked query/queryOne, so the
// dedupe window is exercised for real, not asserted on a canned reply.

interface AuditRow {
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

const h = vi.hoisted(() => ({
  rows: [] as AuditRow[],
  /** Every DB call throws — simulates audit_log (and the owner lookup) being down. */
  dbDown: false,
  supplierDoc: null as null | { id: string; supplier_id: string; file_name: string },
  actor: null as null | { id: string; username: string; email: string; full_name: string | null; role: string },
  /** The owners-portal branch of finance-receipts (28/09/2026). */
  portalSession: null as null | { id: string; phoneE164: string },
  /** The session phone's apartments belong to different people (containment 03/10/2026). */
  mixedOwners: false,
  receipt: null as null | { entry_id: string; document_id: string; original_name: string },
  finDoc: null as null | { id: string; entry_id: string | null; original_name: string },
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (h.dbDown) throw new Error('db down');
    if (/insert into public\.audit_log/i.test(sql)) {
      const [actor_user_id, action, entity_type, entity_id, , metadata] = params as [
        string | null, string, string, string | null, string | null, string | null,
      ];
      h.rows.push({
        actor_user_id, action, entity_type, entity_id,
        metadata: metadata ? (JSON.parse(metadata) as Record<string, unknown>) : null,
        created_at: Date.now(),
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (h.dbDown) throw new Error('db down');
    if (/from public\.audit_log/i.test(sql)) {
      const [who, action, entityType, entityId, fileKey, mins] = params as [string, string, string, string, string, number];
      const since = Date.now() - mins * 60_000;
      const portal = /portal_phone/.test(sql);
      const hit = h.rows.find(
        (r) => (portal ? r.actor_user_id === null && r.metadata?.portal_phone === who : r.actor_user_id === who)
          && r.action === action && r.entity_type === entityType
          && r.entity_id === entityId && r.metadata?.file_key === fileKey && r.created_at > since,
      );
      return hit ? { hit: 1 } : null;
    }
    if (/from public\.supplier_documents/i.test(sql)) return h.supplierDoc;
    if (/from public\.fin_documents/i.test(sql)) return h.finDoc;
    return null;
  }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));
vi.mock('@/lib/auth/actor', async () => {
  const { AuthorizationError } = await import('@/lib/auth/errors');
  const guard = vi.fn(async () => {
    if (!h.actor) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
    return { ...h.actor, permissions: [], isAuthenticated: true as const };
  });
  return { requirePermission: guard, requireAnyPermission: guard };
});
vi.mock('@/lib/portal/session', () => ({
  getPortalSession: vi.fn(async () => h.portalSession),
}));
vi.mock('@/lib/db/finance/portal', () => ({
  findResidentReceipt: vi.fn(async () => h.receipt),
}));
vi.mock('@/lib/db/portal/ownerPhones', () => ({
  findOwnerIdentity: vi.fn(async () => ({ apartmentNumbers: ['7', '12'], ownerName: 'דנה לוי', mixedOwners: h.mixedOwners })),
}));
vi.mock('@/lib/storage/server', () => ({
  PRIVATE_BUCKETS: ['supplier-documents', 'documents', 'issue-attachments', 'whatsapp-attachments', 'finance-receipts'],
  getObjectStream: vi.fn(async () => new Blob(['%PDF-1.4 test'], { type: 'application/pdf' })),
}));
vi.mock('@/lib/db/documents', () => ({
  getDocumentById: vi.fn(async (id: string) => ({
    id,
    file_name: 'דוח שנתי',
    storage_path: 'd0000000-0000-4000-8000-000000000001.pdf',
    mime_type: 'application/pdf',
    entity_type: 'debtor',
    entity_id: 'debtor-77',
  })),
}));
vi.mock('@/lib/storage/documentStorage', () => ({
  downloadDocumentFile: vi.fn(async () => new Blob(['%PDF-1.4 doc'], { type: 'application/pdf' })),
  extOf: (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''),
}));

import { logFileView, FILE_VIEW_ACTION, FILE_VIEW_DEDUPE_MINUTES } from '@/lib/db/fileViewAudit';
import { logger } from '@/lib/logger';
import { GET as filesGET } from '@/app/api/files/[bucket]/[...path]/route';
import { GET as documentDownloadGET } from '@/app/api/documents/[id]/download/route';

const T0 = new Date('2026-09-27T10:00:00Z').getTime();
const MIN = 60_000;

const ronen = { id: 'u-ronen', username: 'ronen', email: 'r@test', full_name: 'רונן משולם', role: 'super_admin' };
const dana = { id: 'u-dana', username: 'dana', email: 'd@test', full_name: null, role: 'admin' };

const OBJECT = 'a1b2c3d4-0000-4000-8000-000000000001.pdf';
const supplierFile = {
  bucket: 'supplier-documents',
  objectKey: OBJECT,
  fileName: 'חוזה שירות 2026.pdf',
  entityType: 'supplier',
  entityId: 'sup-1',
  documentId: 'doc-1',
};

function req(url: string, ip = '10.0.0.7') {
  return new NextRequest(url, { headers: { 'x-forwarded-for': `${ip}, 127.0.0.1` } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.rows = [];
  h.dbDown = false;
  h.supplierDoc = { id: 'doc-1', supplier_id: 'sup-1', file_name: 'חוזה שירות 2026.pdf' };
  h.actor = ronen;
  h.portalSession = null;
  h.mixedOwners = false;
  h.receipt = null;
  h.finDoc = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('logFileView — the row', () => {
  it('records who opened which file, under its parent entity, with the client IP', async () => {
    await logFileView(req('http://localhost/api/files/supplier-documents/' + OBJECT), ronen, supplierFile);

    expect(h.rows).toHaveLength(1);
    const row = h.rows[0];
    expect(row.action).toBe(FILE_VIEW_ACTION);
    expect(row.actor_user_id).toBe('u-ronen');
    expect(row.entity_type).toBe('supplier');
    expect(row.entity_id).toBe('sup-1');
    expect(row.metadata).toMatchObject({
      file_key: `supplier-documents/${OBJECT}`,
      bucket: 'supplier-documents',
      object_key: OBJECT,
      file_name: 'חוזה שירות 2026.pdf',
      document_id: 'doc-1',
      actor_name: 'רונן משולם',
      ip: '10.0.0.7',
    });
  });

  it('falls back to the username when the user has no full name', async () => {
    await logFileView(req('http://localhost/x'), dana, supplierFile);
    expect(h.rows[0].metadata?.actor_name).toBe('dana');
  });
});

describe('logFileView — the 10-minute window', () => {
  it('same user + same file inside the window = one row; after the window a new one', async () => {
    const r = req('http://localhost/x');
    await logFileView(r, ronen, supplierFile);
    vi.setSystemTime(T0 + 3 * MIN);
    await logFileView(r, ronen, supplierFile);
    vi.setSystemTime(T0 + 9 * MIN);
    await logFileView(r, ronen, supplierFile);
    expect(h.rows).toHaveLength(1);

    vi.setSystemTime(T0 + (FILE_VIEW_DEDUPE_MINUTES + 1) * MIN);
    await logFileView(r, ronen, supplierFile);
    expect(h.rows).toHaveLength(2);
  });

  it('a different user, or a different file of the same supplier, is its own row', async () => {
    const r = req('http://localhost/x');
    await logFileView(r, ronen, supplierFile);
    await logFileView(r, dana, supplierFile);
    await logFileView(r, ronen, { ...supplierFile, objectKey: 'ffffffff-0000-4000-8000-000000000002.pdf', documentId: 'doc-2' });
    expect(h.rows).toHaveLength(3);
  });
});

describe('logFileView — failure is swallowed', () => {
  it('a dead audit_log resolves without throwing and reports to the server log', async () => {
    h.dbDown = true;
    await expect(logFileView(req('http://localhost/x'), ronen, supplierFile)).resolves.toBeUndefined();
    expect(h.rows).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('GET /api/files/[bucket]/[...path] — wired after the permission check', () => {
  const ctx = { params: Promise.resolve({ bucket: 'supplier-documents', path: [OBJECT] }) };
  const url = `http://localhost/api/files/supplier-documents/${OBJECT}`;

  it('serves the file and logs the view under the owning supplier, named as the upload row names it', async () => {
    const res = await filesGET(req(url), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4 test');
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('חוזה שירות 2026.pdf'));

    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ action: 'file_viewed', entity_type: 'supplier', entity_id: 'sup-1' });
    expect(h.rows[0].metadata).toMatchObject({ document_id: 'doc-1', file_name: 'חוזה שירות 2026.pdf', ip: '10.0.0.7' });
  });

  it('a refreshed preview inside the window is still one row', async () => {
    await filesGET(req(url), ctx);
    vi.setSystemTime(T0 + 2 * MIN);
    await filesGET(req(url), ctx);
    expect(h.rows).toHaveLength(1);
  });

  it('still serves the file (200, bytes intact) when the audit write fails', async () => {
    h.dbDown = true;
    const res = await filesGET(req(url), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4 test');
    expect(h.rows).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('an object no table claims is served and logged as a bare file', async () => {
    h.supplierDoc = null;
    const res = await filesGET(req(url), ctx);
    expect(res.status).toBe(200);
    expect(h.rows[0]).toMatchObject({ entity_type: 'file', entity_id: `supplier-documents/${OBJECT}` });
  });

  it('denied → 403 and nothing is logged', async () => {
    h.actor = null;
    const res = await filesGET(req(url), ctx);
    expect(res.status).toBe(403);
    expect(h.rows).toHaveLength(0);
  });
});

describe('GET /api/documents/[id]/download — the download route logs too', () => {
  it('one row under the document, with the debtor it belongs to', async () => {
    const id = 'b1b2c3d4-0000-4000-8000-000000000009';
    const res = await documentDownloadGET(
      req(`http://localhost/api/documents/${id}/download`),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ action: 'file_viewed', entity_type: 'document', entity_id: id });
    expect(h.rows[0].metadata).toMatchObject({
      debtor_id: 'debtor-77',
      file_name: 'דוח שנתי',
      file_key: 'documents/d0000000-0000-4000-8000-000000000001.pdf',
    });
  });
});

// ── The owners portal (28/09/2026): an apartment owner opening a receipt ──────
const RECEIPT = 'f1e2d3c4-0000-4000-8000-000000000009.pdf';
const owner = { id: 'ps-1', phoneE164: '+972524187730' };

describe('logFileView — a portal owner', () => {
  it('records the view with no users row: actor_user_id NULL, identified by phone + apartments', async () => {
    const viewer = { kind: 'portal_owner' as const, phoneE164: owner.phoneE164, ownerName: 'דנה לוי', apartmentNumbers: ['7', '12'] };
    const file = { bucket: 'finance-receipts', objectKey: RECEIPT, fileName: 'קבלה.pdf', entityType: 'fin_entry', entityId: 'e-1', documentId: 'd-1' };
    await logFileView(req('http://x/api/files/finance-receipts/' + RECEIPT, '5.6.7.8'), viewer, file);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ actor_user_id: null, action: FILE_VIEW_ACTION, entity_type: 'fin_entry', entity_id: 'e-1' });
    expect(h.rows[0].metadata).toMatchObject({
      actor_kind: 'portal_owner', actor_name: 'דנה לוי', portal_phone: owner.phoneE164, apartment_numbers: ['7', '12'],
      file_key: `finance-receipts/${RECEIPT}`, document_id: 'd-1', ip: '5.6.7.8',
    });
    // the same owner again inside the window is not a new row; another owner is
    await logFileView(req('http://x/'), viewer, file);
    expect(h.rows).toHaveLength(1);
    await logFileView(req('http://x/'), { ...viewer, phoneE164: '+972501111111' }, file);
    expect(h.rows).toHaveLength(2);
    vi.setSystemTime(T0 + (FILE_VIEW_DEDUPE_MINUTES + 1) * MIN);
    await logFileView(req('http://x/'), viewer, file);
    expect(h.rows).toHaveLength(3);
  });
});

describe('GET /api/files/finance-receipts — the portal branch', () => {
  const ctx = { params: Promise.resolve({ bucket: 'finance-receipts', path: [RECEIPT] }) };
  beforeEach(() => {
    h.actor = null; // not staff
    h.finDoc = { id: 'd-1', entry_id: 'e-1', original_name: 'קבלה.pdf' };
  });

  it('no staff, no portal session → the staff verdict (403 here), nothing logged', async () => {
    const res = await filesGET(req(`http://x/api/files/finance-receipts/${RECEIPT}`), ctx);
    expect(res.status).toBe(403);
    expect(h.rows).toHaveLength(0);
  });

  it('a portal session but the receipt is not open to residents (switch off / hidden month) → the staff verdict, nothing logged', async () => {
    h.portalSession = owner;
    h.receipt = null;
    const res = await filesGET(req(`http://x/api/files/finance-receipts/${RECEIPT}`), ctx);
    expect(res.status).toBe(403);
    expect(h.rows).toHaveLength(0);
  });

  it('a portal session and an open receipt → 200, logged as a portal owner under the entry', async () => {
    h.portalSession = owner;
    h.receipt = { entry_id: 'e-1', document_id: 'd-1', original_name: 'קבלה.pdf' };
    const res = await filesGET(req(`http://x/api/files/finance-receipts/${RECEIPT}`, '9.9.9.9'), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4 test');
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ actor_user_id: null, entity_type: 'fin_entry', entity_id: 'e-1' });
    expect(h.rows[0].metadata).toMatchObject({ actor_kind: 'portal_owner', portal_phone: owner.phoneE164, document_id: 'd-1', ip: '9.9.9.9' });
  });

  it('a mixed-owners phone (apartments of different people) → the staff verdict, nothing logged, nothing served', async () => {
    h.portalSession = owner;
    h.mixedOwners = true;
    h.receipt = { entry_id: 'e-1', document_id: 'd-1', original_name: 'קבלה.pdf' };
    const res = await filesGET(req(`http://x/api/files/finance-receipts/${RECEIPT}`), ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('%PDF');
    expect(h.rows).toHaveLength(0);
  });

  it('staff with finance:view still wins the staff path (logged under the user, not as an owner)', async () => {
    h.actor = ronen;
    h.portalSession = owner;
    h.receipt = { entry_id: 'e-1', document_id: 'd-1', original_name: 'קבלה.pdf' };
    const res = await filesGET(req(`http://x/api/files/finance-receipts/${RECEIPT}`), ctx);
    expect(res.status).toBe(200);
    expect(h.rows[0]).toMatchObject({ actor_user_id: 'u-ronen' });
    expect(h.rows[0].metadata).not.toHaveProperty('actor_kind');
  });
});
