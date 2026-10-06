import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The owners-portal side of decisions & protocols, exercised through the REAL
// guard chain — requirePortalFinanceAccess → requirePortalSession →
// getPortalSession → the cookie → findPortalSession → isActiveOwner, then the
// real resolvePortalIdentity over a mocked query(). Only the cookie store, the
// session row, the SQL results and Storage are fakes.
//
// What is locked here:
//   • the list carries ONLY published rows, and the `published` predicate is
//     in the SQL — not in a caller that could forget it;
//   • the list never leaks the object key, the bucket or the uploader;
//   • the file path is 404 without a session, 404 for an unpublished row and
//     404 for an unknown id — one indistinguishable answer, so the route
//     confirms nothing about which documents exist;
//   • ?download=1 turns the disposition into an attachment under the original
//     Hebrew name.

const PHONE = '+972521234567';

const h = vi.hoisted(() => ({
  cookie: 'good-token' as string | null,
  rows: [] as Record<string, unknown>[],
  lastSql: '',
  object: null as Blob | null,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'portal_session' && h.cookie ? { name, value: h.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock('@/lib/db/portal/sessions', () => ({
  findPortalSession: vi.fn(async (token: string) => (token === 'good-token' ? { id: 's1', phoneE164: PHONE } : null)),
  revokePortalSessionsForPhone: vi.fn(),
  revokePortalSession: vi.fn(),
  createPortalSessionRow: vi.fn(),
}));
vi.mock('@/lib/db/portal/ownerPhones', () => ({ isActiveOwner: vi.fn(async () => true) }));
vi.mock('@/lib/db/portal/events', () => ({ logPortalEvent: vi.fn() }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string) => {
    h.lastSql = sql;
    // The identity's roster read — one owner, one apartment, so the phone is
    // never "blocked" and the guard passes on its own terms.
    if (/from public\.apartment_owner_phones/.test(sql)) {
      return { rows: [{ id: 'r0', role: 'owner', apartment_number: '7', owner_name: 'דנה לוי' }], rowCount: 1 };
    }
    if (/from public\.portal_decisions/.test(sql)) {
      // The route must ask for published rows ONLY — assert on the SQL, which
      // is where the predicate has to live.
      const publishedOnly = /published\s*=\s*true/.test(sql);
      const rows = publishedOnly ? h.rows.filter((r) => r.published) : h.rows;
      const byId = /where id = \$1/.test(sql);
      return { rows: byId ? rows.slice(0, 1) : rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[]) => {
    h.lastSql = sql;
    if (/from public\.portal_decisions/.test(sql)) {
      const publishedOnly = /published\s*=\s*true/.test(sql);
      const row = h.rows.find((r) => r.id === params[0]);
      if (!row) return null;
      return publishedOnly && !row.published ? null : row;
    }
    return null;
  }),
}));
vi.mock('@/lib/storage/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/storage/server')>()),
  getObjectStream: vi.fn(async () => h.object),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET as listGet } from '@/app/api/portal/decisions/route';
import { GET as fileGet } from '@/app/api/portal/decisions/[id]/file/route';

function decision(over: Record<string, unknown> = {}) {
  return {
    id: 'dec-1',
    title: 'אישור תקציב הבניין לשנת 2026',
    summary: 'האסיפה אישרה את התקציב.',
    doc_type: 'decision',
    decision_number: '04/2026',
    decided_at: '2026-03-15',
    bucket: 'portal-decisions',
    object_key: '11111111-1111-4111-8111-111111111111.pdf',
    original_filename: 'תקציב 2026.pdf',
    file_size: 524288,
    mime_type: 'application/pdf',
    published: true,
    created_by: 'u1',
    created_at: '2026-03-15T10:00:00.000Z',
    updated_at: '2026-03-15T10:00:00.000Z',
    ...over,
  };
}

function fileReq(id: string, qs = '') {
  return fileGet(
    new NextRequest(`http://localhost/api/portal/decisions/${id}/file${qs}`),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  h.cookie = 'good-token';
  h.rows = [decision(), decision({ id: 'dec-2', title: 'טיוטה', published: false, object_key: 'x.pdf' })];
  h.object = new Blob([new Uint8Array(1024)], { type: 'application/pdf' });
  h.lastSql = '';
});

describe('GET /api/portal/decisions', () => {
  it('returns published rows only, and asks the DB for them', async () => {
    const res = await listGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].id).toBe('dec-1');
    // The filter is in the SQL, not applied after the fact.
    expect(h.lastSql).toMatch(/published\s*=\s*true/);
  });

  it('never carries the object key, the bucket or the uploader to a resident', async () => {
    const body = await (await listGet()).json();
    const row = body.decisions[0];
    expect(Object.keys(row).sort()).toEqual(
      ['decided_at', 'decision_number', 'doc_type', 'file_size', 'id', 'summary', 'title'],
    );
    expect(JSON.stringify(body)).not.toContain('portal-decisions');
    expect(JSON.stringify(body)).not.toContain('.pdf');
  });

  it('401s without a portal session', async () => {
    h.cookie = null;
    expect((await listGet()).status).toBe(401);
  });
});

describe('GET /api/portal/decisions/[id]/file', () => {
  it('streams a published document inline', async () => {
    const res = await fileReq('dec-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline;/);
    // The Hebrew name survives as the RFC 5987 form.
    expect(res.headers.get('Content-Disposition')).toContain(encodeURIComponent('תקציב 2026.pdf'));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('?download=1 sends it as an attachment', async () => {
    const res = await fileReq('dec-1', '?download=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });

  it('404s without a session — not 401, so it confirms nothing', async () => {
    h.cookie = null;
    const res = await fileReq('dec-1');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('404s on an unpublished row, exactly like an unknown id', async () => {
    const hidden = await fileReq('dec-2');
    const missing = await fileReq('dec-404');
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('404s when the row is readable but the object is gone', async () => {
    h.object = null;
    expect((await fileReq('dec-1')).status).toBe(404);
  });
});
