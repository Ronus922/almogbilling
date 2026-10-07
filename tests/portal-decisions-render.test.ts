import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortalDecisions } from '@/components/portal/PortalDecisions';
import type { DecisionPortalView } from '@/lib/decisionsView';

// The "החלטות" tab as the resident receives it (ref/portal/decisions-tab.md).
// Rendered rather than asserted on props, because the things that matter here
// are in the markup: which links the two buttons carry, which rows open a year
// separator, and that the toolbar holds a search field and NOTHING else — the
// declared exception that drops the reference's category chips.

const row = (over: Partial<DecisionPortalView> = {}): DecisionPortalView => ({
  id: 'dec-1',
  title: 'אישור תקציב הבניין לשנת 2026',
  summary: 'האסיפה השנתית אישרה את תקציב 2026.',
  doc_type: 'decision',
  decision_number: '04/2026',
  decided_at: '2026-03-15',
  file_size: 524288,
  ...over,
});

const html = (decisions: DecisionPortalView[]) =>
  renderToStaticMarkup(createElement(PortalDecisions, { decisions }));

describe('the portal decisions tab', () => {
  it('renders the reference row: tag, date, size and the chevron', () => {
    const h = html([row()]);
    expect(h).toContain('החלטה 04/2026');
    expect(h).toContain('15.03.2026');
    expect(h).toContain('512 KB');
    expect(h).toContain('class="dic"');
    expect(h).toContain('chev');
  });

  it('both buttons point at the portal route — and the download one says so', () => {
    const h = html([row()]);
    expect(h).toContain('href="/api/portal/decisions/dec-1/file"');
    expect(h).toContain('href="/api/portal/decisions/dec-1/file?download=1"');
    expect(h).toContain('פתיחת המסמך');
    expect(h).toContain('הורדה');
    // Nothing in the markup may point at Storage or name an object key.
    expect(h).not.toContain('/api/files/');
    expect(h).not.toContain('portal-decisions');
  });

  it('the admin preview passes staff URLs — both buttons follow them (07/10/2026)', () => {
    const staff = '/api/files/portal-decisions/ae9d14e6-6471-4e39-86a4-0e940f5a8e37.pdf';
    const h = renderToStaticMarkup(createElement(PortalDecisions, { decisions: [row()], staffFileUrls: { 'dec-1': staff } }));
    expect(h).toContain(`href="${staff}"`);
    expect(h).toContain(`href="${staff}?download=1"`);
    expect(h).not.toContain('/api/portal/decisions/');
  });

  it('a protocol gets the green tag and no number', () => {
    const h = html([row({ doc_type: 'protocol', decision_number: '04/2026' })]);
    expect(h).toContain('t-green');
    expect(h).toContain('פרוטוקול');
    expect(h).not.toContain('04/2026');
  });

  it('opens a year separator per year, once', () => {
    const h = html([
      row({ id: 'a', decided_at: '2026-03-15' }),
      row({ id: 'b', decided_at: '2026-01-20' }),
      row({ id: 'c', decided_at: '2025-11-05' }),
    ]);
    expect(h.match(/class="yr num"/g)).toHaveLength(2);
    expect(h).toContain('>2026<');
    expect(h).toContain('>2025<');
  });

  it('the toolbar is the search field alone — no category chips', () => {
    const h = html([row()]);
    expect(h).toContain('חיפוש החלטה או פרוטוקול');
    // The chips carried their own class and their own container — neither is
    // rendered. ("אסיפות דיירים" is NOT asserted against: it legitimately
    // appears in the page subtitle, "פרוטוקולי אסיפות דיירים".)
    expect(h).not.toContain('chipf');
    expect(h).not.toContain('class="chips"');
    for (const chip of ['תקציב וכספים', 'תחזוקה ושיפוצים']) {
      expect(h).not.toContain(chip);
    }
  });

  it('a row with no summary renders its buttons and no empty paragraph', () => {
    const h = html([row({ summary: null })]);
    expect(h).toContain('פתיחת המסמך');
    expect(h).not.toContain('<p></p>');
  });

  it('no documents at all → the empty tab, not an empty search', () => {
    const h = html([]);
    expect(h).toContain('עדיין לא פורסמו החלטות או פרוטוקולים');
    expect(h).not.toContain('חיפוש החלטה או פרוטוקול');
    expect(h).not.toContain('לא נמצאו תוצאות');
  });
});
