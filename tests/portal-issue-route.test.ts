import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/portal/issues — the owners portal's fault report, exercised through
// the REAL guard chain: requirePortalSession → getPortalSession → the cookie →
// findPortalSession → isActiveOwner. Only the cookie store, the session /
// roster / issue SQL, Storage and the notification insert are mocked.
//   • no session → 401, nothing written, nothing uploaded;
//   • the reporter is resolved from the SESSION phone — reporter/phone/apartment
//     keys in the body are never read;
//   • 6 photos, a video, a PDF, a photo over 5MB, a 2001-character description
//     → 400 before anything is written;
//   • the 201 carries the confirmation screen's summary only (no issue id, no
//     phone), and every active admin gets the "תקלה חדשה נפתחה" bell.

const SESSION_PHONE = '+972521112233';
const BODY_PHONE = '+972509999999';

const h = vi.hoisted(() => ({ cookie: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'portal_session' && h.cookie ? { name, value: h.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock('@/lib/db/portal/sessions', () => ({
  findPortalSession: vi.fn(async (token: string) => (token === 'good-token' ? { id: 's1', phoneE164: SESSION_PHONE } : null)),
  revokePortalSessionsForPhone: vi.fn(),
  revokePortalSession: vi.fn(),
  createPortalSessionRow: vi.fn(),
}));
vi.mock('@/lib/db/portal/ownerPhones', () => ({ isActiveOwner: vi.fn(async () => true) }));
vi.mock('@/lib/db/portal/events', () => ({ logPortalEvent: vi.fn() }));
vi.mock('@/lib/db/portal/issueReport', () => ({
  resolvePortalReporter: vi.fn(async (phone: string) => ({
    rosterId: 'roster-of-session', apartmentNumber: '520', name: 'בעלת הדירה', phoneE164: phone,
  })),
  insertPortalIssue: vi.fn(async (args: { id: string; report: { location: string; description: string } }) => ({
    id: args.id, title: `דיווח דייר · ${args.report.location}`, description: args.report.description, ticketNumber: 1042,
  })),
}));
vi.mock('@/lib/storage/issueStorage', () => ({
  uploadIssueImage: vi.fn(async (issueId: string, file: File) => ({ path: `${issueId}/${file.name}`, sizeBytes: file.size, mimeType: file.type })),
  removeIssueImages: vi.fn(async () => undefined),
}));
vi.mock('@/services/notifications', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/users', () => ({
  listActiveAdmins: vi.fn(async () => [{ id: 'admin-1', name: 'א' }, { id: 'admin-2', name: 'ב' }]),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from '@/app/api/portal/issues/route';
import { insertPortalIssue, resolvePortalReporter } from '@/lib/db/portal/issueReport';
import { removeIssueImages, uploadIssueImage } from '@/lib/storage/issueStorage';
import { createNotification } from '@/services/notifications';

const MB = 1024 * 1024;

function jpeg(name = 'a.jpg', size = 1000, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function report(fields: Record<string, string> = {}, files: File[] = []) {
  const fd = new FormData();
  const base = { location: 'חדר מדרגות', area: 'בין קומה 2 ל-3', description: 'נורה שרופה מעל המדרגות', urgency: 'medium' };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.append(k, v);
  for (const f of files) fd.append('images', f);
  return POST(new NextRequest('http://localhost/api/portal/issues', { method: 'POST', body: fd }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cookie = 'good-token';
});

describe('POST /api/portal/issues — who may report', () => {
  it('no portal session → 401; nothing is resolved, uploaded or written', async () => {
    h.cookie = null;
    const res = await report({}, [jpeg()]);
    expect(res.status).toBe(401);
    expect(resolvePortalReporter).not.toHaveBeenCalled();
    expect(uploadIssueImage).not.toHaveBeenCalled();
    expect(insertPortalIssue).not.toHaveBeenCalled();
  });

  it('a cookie that matches no live session → 401', async () => {
    h.cookie = 'stale-token';
    expect((await report()).status).toBe(401);
    expect(insertPortalIssue).not.toHaveBeenCalled();
  });
});

describe('POST /api/portal/issues — the reporter comes from the session only', () => {
  it('reporter/phone/apartment keys in the body are ignored; the session phone decides', async () => {
    const res = await report({
      reporter_phone: BODY_PHONE, phone: BODY_PHONE, apartment: '1', reporter_apartment: '1',
      reporter_name: 'מתחזה', reporter_contact_id: '00000000-0000-0000-0000-000000000000',
      source: 'staff', priority: 'urgent', title: 'כותרת מהגוף',
    });
    expect(res.status).toBe(201);
    expect(resolvePortalReporter).toHaveBeenCalledTimes(1);
    expect(resolvePortalReporter).toHaveBeenCalledWith(SESSION_PHONE);

    const args = vi.mocked(insertPortalIssue).mock.calls[0]![0];
    expect(args.reporter).toEqual({ rosterId: 'roster-of-session', apartmentNumber: '520', name: 'בעלת הדירה', phoneE164: SESSION_PHONE });
    expect(args.report).toEqual({ location: 'חדר מדרגות', area: 'בין קומה 2 ל-3', description: 'נורה שרופה מעל המדרגות', urgency: 'medium' });
    expect(JSON.stringify(args)).not.toContain(BODY_PHONE);
    expect(JSON.stringify(args)).not.toContain('מתחזה');
  });

  it('201 = the confirmation summary only: call number, location, urgency, photo count — no id, no phone', async () => {
    const res = await report({}, [jpeg('1.jpg'), jpeg('2.png', 500, 'image/png')]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      report: { ticketNumber: 1042, location: 'חדר מדרגות', area: 'בין קומה 2 ל-3', urgency: 'medium', imageCount: 2 },
    });
    const id = vi.mocked(insertPortalIssue).mock.calls[0]![0].id;
    expect(JSON.stringify(body)).not.toContain(id);
    expect(JSON.stringify(body)).not.toContain(SESSION_PHONE);
  });

  it('photos are uploaded under the new issue id BEFORE the row is written, and the row names them', async () => {
    await report({}, [jpeg('1.jpg'), jpeg('2.jpg')]);
    const args = vi.mocked(insertPortalIssue).mock.calls[0]![0];
    expect(vi.mocked(uploadIssueImage).mock.calls.map((c) => c[0])).toEqual([args.id, args.id]);
    expect(args.images).toEqual([`${args.id}/1.jpg`, `${args.id}/2.jpg`]);
    expect(vi.mocked(uploadIssueImage).mock.invocationCallOrder[1]!)
      .toBeLessThan(vi.mocked(insertPortalIssue).mock.invocationCallOrder[0]!);
  });

  it('an upload that fails mid-way removes what was uploaded and writes nothing (500)', async () => {
    vi.mocked(uploadIssueImage)
      .mockImplementationOnce(async (issueId: string) => ({ path: `${issueId}/ok.jpg`, sizeBytes: 1, mimeType: 'image/jpeg' }))
      .mockImplementationOnce(async () => { throw new Error('storage down'); });
    const res = await report({}, [jpeg('1.jpg'), jpeg('2.jpg')]);
    expect(res.status).toBe(500);
    expect(insertPortalIssue).not.toHaveBeenCalled();
    expect(removeIssueImages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(removeIssueImages).mock.calls[0]![0]).toHaveLength(1);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('every active admin gets the existing "תקלה חדשה נפתחה" bell (no reporter user to skip)', async () => {
    await report();
    await vi.waitFor(() => expect(createNotification).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(createNotification).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.userId).sort()).toEqual(['admin-1', 'admin-2']);
    for (const c of calls) {
      expect(c.type).toBe('issue_reported');
      expect(c.title).toBe('תקלה חדשה נפתחה');
      expect(c.message).toContain('דיווח דייר · חדר מדרגות');
    }
  });
});

describe('POST /api/portal/issues — the server validates like the screen', () => {
  async function rejected(res: Response, error: string) {
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    expect(uploadIssueImage).not.toHaveBeenCalled();
    expect(insertPortalIssue).not.toHaveBeenCalled();
  }

  it('6 photos → 400 too_many_images', async () => {
    await rejected(await report({}, Array.from({ length: 6 }, (_, i) => jpeg(`${i}.jpg`))), 'too_many_images');
  });

  it('a video → 400 invalid_file_type', async () => {
    await rejected(await report({}, [jpeg(), jpeg('clip.mp4', 1000, 'video/mp4')]), 'invalid_file_type');
  });

  it('a non-image (PDF) → 400 invalid_file_type', async () => {
    await rejected(await report({}, [jpeg('doc.pdf', 1000, 'application/pdf')]), 'invalid_file_type');
  });

  it('a photo over 5MB reaching the server → 400 file_too_large (the server limit is not raised)', async () => {
    await rejected(await report({}, [jpeg('big.jpg', 5 * MB + 1)]), 'file_too_large');
  });

  it('a 2001-character description → 400 with the field error', async () => {
    const res = await report({ description: 'א'.repeat(2001) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: Record<string, string> };
    expect(body.error).toBe('invalid_fields');
    expect(body.errors.description).toContain('2000');
    expect(insertPortalIssue).not.toHaveBeenCalled();
  });

  it('a one-letter location → 400 "יש לציין היכן התקלה"', async () => {
    const res = await report({ location: ' א ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Record<string, string> }).errors.location).toBe('יש לציין היכן התקלה');
  });

  it('5 photos is allowed', async () => {
    const res = await report({}, Array.from({ length: 5 }, (_, i) => jpeg(`${i}.jpg`)));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { report: { imageCount: number } }).report.imageCount).toBe(5);
  });
});
