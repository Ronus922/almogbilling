import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The 07/10/2026 production bug: in the admin preview of the portal
// (/finance?view=resident&tab=dec) "פתיחת המסמך" and "הורדה" answered
// {"error":"not_found"}. The buttons pointed at the owners' route, which
// demands a portal session — staff have none, so it gave them its uniform 404.
// PortalScreen is where the caller is known, so this renders it whole, every
// way: the portal keeps the owners' route; the preview gets the staff path —
// unless the staff viewer lacks portal_decisions:view, in which case the rows
// carry no buttons and no object key at all (the backlog item closed
// 07/10/2026: hidden up front instead of a 403 after the click).

const ROWS = [
  {
    id: 'dec-a', title: 'תוצאות הצבעה', summary: null, doc_type: 'decision', decision_number: null,
    decided_at: '2026-10-05', object_key: 'ae9d14e6-6471-4e39-86a4-0e940f5a8e37.pdf',
    original_filename: 'הצבעה.pdf', file_size: 196814, mime_type: 'application/pdf', published: true,
    uploaded_by: null, created_at: '2026-10-06T04:45:50Z', updated_at: '2026-10-06T04:45:50Z',
  },
  {
    id: 'dec-b', title: 'תוצאות בחירות', summary: 'השלמת חברי נציגות', doc_type: 'protocol', decision_number: null,
    decided_at: '2026-10-04', object_key: '5a49a297-fca8-4b1b-9aa1-b3d3939370b6.pdf',
    original_filename: 'בחירות.pdf', file_size: 250700, mime_type: 'application/pdf', published: true,
    uploaded_by: null, created_at: '2026-10-06T04:49:27Z', updated_at: '2026-10-06T04:49:27Z',
  },
];

vi.mock('@/lib/db/portalDecisions', () => ({ listPublishedDecisions: vi.fn(async () => ROWS) }));
vi.mock('@/lib/db/contacts', () => ({ countContacts: vi.fn(async () => 120) }));
vi.mock('@/lib/db/finance/portal', () => ({
  getPublishedMonths: vi.fn(async () => []),
  getPeriodReport: vi.fn(),
  getResidentFundKpis: vi.fn(),
  getResidentOverview: vi.fn(),
  getResidentPeriodData: vi.fn(),
}));
vi.mock('@/lib/storage/server', () => ({
  PORTAL_DECISIONS_BUCKET: 'portal-decisions',
  buildProxyUrl: (bucket: string, path: string) => `/api/files/${bucket}/${encodeURIComponent(path)}`,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/finance',
  useSearchParams: () => new URLSearchParams('view=resident&tab=dec'),
}));

import { PortalScreen } from '@/components/portal/PortalScreen';

async function render(preview: boolean, previewCanOpenDecisionFiles = false): Promise<string> {
  const el = await PortalScreen({
    params: { tab: 'dec' },
    user: { name: null, apartments: [] },
    accounts: [],
    support: { phone: null, email: null },
    preview,
    previewCanOpenDecisionFiles,
  });
  return renderToStaticMarkup(el);
}

describe('PortalScreen — where the decision buttons lead', () => {
  it('the admin preview opens and downloads through the staff path, never the owners route', async () => {
    const h = await render(true, true);
    for (const r of ROWS) {
      expect(h).toContain(`href="/api/files/portal-decisions/${r.object_key}"`);
      expect(h).toContain(`href="/api/files/portal-decisions/${r.object_key}?download=1"`);
    }
    expect(h).not.toContain('/api/portal/decisions/');
  });

  it('the portal itself keeps the owners route and never names an object key', async () => {
    const h = await render(false);
    for (const r of ROWS) {
      expect(h).toContain(`href="/api/portal/decisions/${r.id}/file"`);
      expect(h).toContain(`href="/api/portal/decisions/${r.id}/file?download=1"`);
      expect(h).not.toContain(r.object_key);
    }
    expect(h).not.toContain('/api/files/');
    expect(h).not.toContain('dlock');
  });

  it('a preview viewer without portal_decisions:view gets the rows, a note — and no file path', async () => {
    const h = await render(true, false);
    for (const r of ROWS) {
      expect(h).toContain(r.title);
      expect(h).not.toContain(r.object_key);
    }
    expect(h).not.toContain('/api/files/');
    expect(h).not.toContain('/api/portal/decisions/');
    expect(h).not.toContain('פתיחת המסמך</a>');
    expect(h).not.toContain('class="dact"');
    expect(h.match(/class="dlock"/g)).toHaveLength(ROWS.length);
    expect(h).toContain('הרשאת „החלטות ופרוטוקולים”');
  });

  it('the permission flag means nothing outside the preview — the portal keeps its own route', async () => {
    const h = await render(false, false);
    for (const r of ROWS) expect(h).toContain(`href="/api/portal/decisions/${r.id}/file"`);
    expect(h).not.toContain('dlock');
  });
});
