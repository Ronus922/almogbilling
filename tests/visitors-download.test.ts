import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// "הורד תמונה" (09/11/2026): the stored photo of a scanned document leaves the system through
// /api/files/visitor-ids/<key>?download=1 as an attachment named {last}_{first}_{YYYY-MM-DD}.jpg,
// and every such download is its OWN audit row (`file_downloaded`), apart from `file_viewed`.
//   • the name: Hebrew intact (RFC 5987), nothing illegal in a file name, ' ( ) * encoded too;
//   • the audit: one row per download, no dedupe, no person's name in the metadata;
//   • a plain open stays inline and stays a `file_viewed`; other buckets are untouched;
//   • a role outside the visitor screen gets 403 and leaves no row;
//   • a failing audit_log never withholds the file.
// The DB is an in-memory audit table behind the mocked query/queryOne.

interface AuditRow {
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
}

const h = vi.hoisted(() => ({
  rows: [] as AuditRow[],
  dbDown: false,
  actor: null as null | { id: string; username: string; email: string | null; full_name: string | null; role: string },
  scan: null as null | { id: string; image_original_name: string | null; first_name: string; last_name: string; scan_date: string },
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/insert into public\.audit_log/i.test(sql)) {
      if (h.dbDown) throw new Error('db down');
      const [actor_user_id, action, entity_type, entity_id, , metadata] = params as [string | null, string, string, string | null, string | null, string | null];
      h.rows.push({ actor_user_id, action, entity_type, entity_id, metadata: metadata ? (JSON.parse(metadata) as Record<string, unknown>) : null });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
  queryOne: vi.fn(async (sql: string) => {
    if (h.dbDown) throw new Error('db down');
    if (/from public\.audit_log/i.test(sql)) return null; // the dedupe lookup of file_viewed: never a hit here
    if (/from public\.visitor_scans/i.test(sql)) return h.scan;
    if (/from public\.supplier_documents/i.test(sql)) return { id: 'doc-1', supplier_id: 'sup-1', file_name: 'חוזה.pdf' };
    return null;
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } }));
vi.mock('@/lib/auth/actor', async () => {
  const { AuthorizationError } = await import('@/lib/auth/errors');
  const guard = vi.fn(async () => {
    if (!h.actor) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
    return { ...h.actor, permissions: [], isAuthenticated: true as const };
  });
  return { requirePermission: guard, requireAnyPermission: guard, requireVisitorView: guard };
});
vi.mock('@/lib/auth/purchasingGuard', () => ({ requirePurchasingAny: vi.fn() }));
vi.mock('@/lib/portal/session', () => ({ getPortalSession: vi.fn(async () => null) }));
vi.mock('@/lib/db/finance/portal', () => ({ findResidentReceipt: vi.fn(async () => null) }));
vi.mock('@/lib/db/portal/identity', () => ({ resolvePortalIdentity: vi.fn(async () => null) }));
vi.mock('@/lib/storage/server', () => ({
  PRIVATE_BUCKETS: ['supplier-documents', 'visitor-ids'],
  getObjectStream: vi.fn(async (bucket: string) =>
    new Blob(['jpeg-bytes'], { type: bucket === 'visitor-ids' ? 'image/jpeg' : 'application/pdf' })),
}));

import { GET } from '@/app/api/files/[bucket]/[...path]/route';
import { logFileDownload, FILE_DOWNLOAD_ACTION } from '@/lib/db/fileViewAudit';
import { visitorDownloadName, cleanNamePart } from '@/lib/visitors/downloadName';
import { logger } from '@/lib/logger';

const KEY = 'a1b2c3d4-0000-4000-8000-0000000000aa.jpg';
const guard = { id: 'u-guard', username: 'gate', email: null, full_name: 'שומר שער', role: 'guard' };

const open = (qs = '', bucket = 'visitor-ids', key = KEY) =>
  GET(new NextRequest(`http://localhost/api/files/${bucket}/${key}${qs}`, { headers: { 'x-real-ip': '10.0.0.7' } }),
    { params: Promise.resolve({ bucket, path: [key] }) });

/** The decoded UTF-8 name of a Content-Disposition's `filename*`. */
const utf8Name = (cd: string | null) => decodeURIComponent(cd!.split("filename*=UTF-8''")[1]!);

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.dbDown = false;
  h.actor = guard;
  h.scan = { id: 'scan-1', image_original_name: 'IMG_0001.jpg', first_name: 'דוד', last_name: 'כהן', scan_date: '2026-11-09' };
});

describe('GET /api/files/visitor-ids?download=1', () => {
  it('answers an attachment named {last}_{first}_{date}.jpg, the Hebrew intact', async () => {
    const res = await open('?download=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const cd = res.headers.get('content-disposition')!;
    expect(cd.startsWith('attachment;')).toBe(true);
    expect(utf8Name(cd)).toBe('כהן_דוד_2026-11-09.jpg');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('records ONE file_downloaded row per download — no dedupe — and no file_viewed', async () => {
    await open('?download=1');
    await open('?download=1');
    expect(h.rows.map((r) => r.action)).toEqual([FILE_DOWNLOAD_ACTION, FILE_DOWNLOAD_ACTION]);
    expect(h.rows[0]).toMatchObject({ actor_user_id: 'u-guard', entity_type: 'visitor_scan', entity_id: 'scan-1' });
    expect(h.rows[0]!.metadata).toMatchObject({
      bucket: 'visitor-ids', object_key: KEY, file_key: `visitor-ids/${KEY}`, actor_name: 'שומר שער', ip: '10.0.0.7',
    });
  });

  it('puts no name of a person in the audit row: the visitor\'s name is in the header only', async () => {
    await open('?download=1');
    const meta = JSON.stringify(h.rows[0]!.metadata);
    expect(meta).not.toContain('כהן');
    expect(meta).not.toContain('דוד');
    expect(meta).toContain('IMG_0001.jpg'); // the camera's own file name, as for file_viewed
  });

  it('a plain open stays inline and stays a file_viewed (and a repeat inside the window is not a new row only because the lookup said so)', async () => {
    const res = await open();
    expect(res.headers.get('content-disposition')!.startsWith('inline;')).toBe(true);
    expect(h.rows.map((r) => r.action)).toEqual(['file_viewed']);
  });

  it('a name with an apostrophe or brackets is percent-encoded whole (RFC 5987), and nothing illegal survives', async () => {
    h.scan = { id: 'scan-1', image_original_name: null, first_name: 'Mary-Ann (Jr.)*', last_name: 'O\'Brien/"X"', scan_date: '2026-11-09' };
    const cd = (await open('?download=1')).headers.get('content-disposition')!;
    const encoded = cd.split("filename*=UTF-8''")[1]!;
    expect(encoded).not.toMatch(/['()*"/\\]/); // attr-char of RFC 5987 allows none of these raw
    expect(encoded).toContain('%27'); // the apostrophe, kept in the name but encoded
    expect(encoded).toContain('%28');
    expect(encoded).toContain('%29');
    // `/`, `"` and `*` cannot be in a file name: each became an underscore before the encoding
    expect(utf8Name(cd)).toBe("O'Brien__X__Mary-Ann (Jr.)__2026-11-09.jpg");
  });

  it('a role outside the visitor screen: 403, no body, no audit row', async () => {
    h.actor = null;
    const res = await open('?download=1');
    expect(res.status).toBe(403);
    expect(h.rows).toHaveLength(0);
  });

  it('a failing audit_log never withholds the photo — and the failure is logged', async () => {
    h.dbDown = true;
    // the owner lookup fails too (same DB): the file is served under the bare object
    const res = await open('?download=1');
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalled();
  });

  it('other buckets are untouched: ?download=1 there is still a file_viewed, never a file_downloaded', async () => {
    const res = await open('?download=1', 'supplier-documents', 'a1b2c3d4-0000-4000-8000-000000000001.pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')!.startsWith('attachment;')).toBe(true);
    expect(h.rows.map((r) => r.action)).toEqual(['file_viewed']);
  });
});

describe('logFileDownload', () => {
  it('never throws, whatever the metadata builder or the DB does', async () => {
    h.dbDown = true;
    await expect(logFileDownload(new Request('http://localhost/x'), guard, {
      bucket: 'visitor-ids', objectKey: KEY, fileName: null, entityType: 'visitor_scan', entityId: 'scan-1',
    })).resolves.toBeUndefined();
  });
});

describe('visitorDownloadName', () => {
  const base = { scanDate: '2026-11-09', objectKey: KEY };

  it('is {last}_{first}_{date}.jpg', () => {
    expect(visitorDownloadName({ ...base, lastName: 'כהן', firstName: 'דוד' })).toBe('כהן_דוד_2026-11-09.jpg');
  });

  it('turns every character a file name cannot hold into an underscore', () => {
    expect(visitorDownloadName({ ...base, lastName: 'a/b\\c:d*e?f"g<h>i|j', firstName: 'x' })).toBe('a_b_c_d_e_f_g_h_i_j_x_2026-11-09.jpg');
  });

  it('drops control and bidi marks, collapses spaces, trims dots and spaces at the ends', () => {
    expect(cleanNamePart('‮בן   דוד‏\u0000\t')).toBe('בן דוד');
    expect(cleanNamePart('  ..hidden.. ')).toBe('hidden');
    expect(cleanNamePart('...')).toBe('');
  });

  it('leaves out a missing name or date instead of leaving a hole, and never returns an empty name', () => {
    expect(visitorDownloadName({ ...base, lastName: '', firstName: 'דוד' })).toBe('דוד_2026-11-09.jpg');
    expect(visitorDownloadName({ ...base, lastName: 'כהן', firstName: null, scanDate: 'garbage' })).toBe('כהן.jpg');
    expect(visitorDownloadName({ lastName: '', firstName: '', scanDate: null, objectKey: KEY })).toBe('scan.jpg');
  });

  it('caps each name at 32 characters - by code point, so a pair of surrogates is never cut in half', () => {
    expect(visitorDownloadName({ ...base, lastName: 'א'.repeat(300), firstName: 'ב' })).toBe(`${'א'.repeat(32)}_ב_2026-11-09.jpg`);
    // 31 letters, then an astral character (2 UTF-16 units) that straddles the cut, then more
    const straddle = visitorDownloadName({ ...base, lastName: `${'a'.repeat(31)}\u{1F600}bcd`, firstName: 'x' });
    expect(straddle).toBe(`${'a'.repeat(31)}\u{1F600}_x_2026-11-09.jpg`);
    expect(() => encodeURIComponent(straddle)).not.toThrow(); // a lone surrogate would throw here
  });

  it('two maximal names still fit the 255 bytes of a file name, in Hebrew and in CJK', () => {
    for (const ch of ['א', '漢']) {
      const name = visitorDownloadName({ ...base, lastName: ch.repeat(100), firstName: ch.repeat(100) });
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    }
  });

  it('drops the Arabic letter mark along with the other invisible bidi marks', () => {
    expect(cleanNamePart('כהן\u061c\u200e')).toBe('כהן');
  });

  it('takes the extension from the stored object: .jpg, or .webp for a row the conversion has not reached', () => {
    expect(visitorDownloadName({ ...base, lastName: 'כהן', firstName: 'דוד', objectKey: 'a1b2c3d4-0000-4000-8000-0000000000aa.webp' })).toBe('כהן_דוד_2026-11-09.webp');
    expect(visitorDownloadName({ ...base, lastName: 'כהן', firstName: 'דוד', objectKey: 'whatever' })).toBe('כהן_דוד_2026-11-09.jpg');
  });
});
