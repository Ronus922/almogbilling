import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER, filterDocuments, inDateRange, isFiltering, matchesQuery, offersSummary, sortDocuments, suppliersLine,
} from '@/components/purchasing/listView';
import type { DocumentListItem } from '@/components/purchasing/types';

// Only the fields the list rules read; the rest of a row is irrelevant to them.
const doc = (over: Partial<DocumentListItem>): DocumentListItem => ({
  id: 'x', doc_type: 'rfq', number: 1, status: 'issued', doc_date: '2026-10-01', title: '', supplier_name: null,
  created_at: '2026-10-01T08:00:00.000Z', quote_count: 0, recipient_count: 0, parties: [],
  ...over,
} as DocumentListItem);

const RFQ = doc({
  id: 'a', number: 10010, title: 'ציוד חשמל לבניין A', doc_date: '2026-10-26',
  parties: [{ key: 'k1', name: 'חשמל כהן בע״מ' }, { key: 'k2', name: 'א.ב. אספקה טכנית' }],
});
const PO = doc({ id: 'b', doc_type: 'po', number: 71, title: 'תחזוקת מעליות', supplier_name: 'אלקטרה מעליות', doc_date: '2026-09-30' });
const DRAFT = doc({ id: 'c', number: null, status: 'draft', title: 'טיוטה של צביעה', doc_date: '2026-10-27' });

describe('matchesQuery', () => {
  it('an empty or blank search keeps everything', () => {
    expect(matchesQuery(RFQ, '')).toBe(true);
    expect(matchesQuery(RFQ, '   ')).toBe(true);
  });
  it('reads the subject, a recipient of a request, the supplier of an order and the number', () => {
    expect(matchesQuery(RFQ, 'חשמל')).toBe(true);
    expect(matchesQuery(RFQ, 'אספקה טכנית')).toBe(true);
    expect(matchesQuery(RFQ, '10010')).toBe(true);
    expect(matchesQuery(RFQ, '100')).toBe(true);
    expect(matchesQuery(PO, 'אלקטרה')).toBe(true);
    expect(matchesQuery(PO, '71')).toBe(true);
    expect(matchesQuery(RFQ, 'אלקטרה')).toBe(false);
  });
  it('is case-insensitive and ignores surrounding spaces', () => {
    expect(matchesQuery(RFQ, '  בניין a  ')).toBe(true);
  });
  it('a draft has no number: it is found by its subject only', () => {
    expect(matchesQuery(DRAFT, 'צביעה')).toBe(true);
    expect(matchesQuery(DRAFT, 'null')).toBe(false);
  });
});

describe('inDateRange', () => {
  it('open on either side, inclusive on both', () => {
    expect(inDateRange(RFQ, '', '')).toBe(true);
    expect(inDateRange(RFQ, '2026-10-26', '')).toBe(true);
    expect(inDateRange(RFQ, '2026-10-27', '')).toBe(false);
    expect(inDateRange(RFQ, '', '2026-10-26')).toBe(true);
    expect(inDateRange(RFQ, '', '2026-10-25')).toBe(false);
    expect(inDateRange(RFQ, '2026-10-01', '2026-10-31')).toBe(true);
  });
  it('an inverted range keeps nothing', () => {
    expect(inDateRange(RFQ, '2026-11-01', '2026-10-01')).toBe(false);
  });
});

describe('filterDocuments / isFiltering', () => {
  it('both filters must hold', () => {
    const all = [RFQ, PO, DRAFT];
    expect(filterDocuments(all, EMPTY_FILTER)).toEqual(all);
    expect(filterDocuments(all, { q: 'אלקטרה', from: '', to: '' })).toEqual([PO]);
    expect(filterDocuments(all, { q: '', from: '2026-10-01', to: '2026-10-31' })).toEqual([RFQ, DRAFT]);
    expect(filterDocuments(all, { q: 'צביעה', from: '2026-10-01', to: '2026-10-26' })).toEqual([]);
  });
  it('knows when something is filtering', () => {
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
    expect(isFiltering({ q: '  ', from: '', to: '' })).toBe(false);
    expect(isFiltering({ q: 'x', from: '', to: '' })).toBe(true);
    expect(isFiltering({ q: '', from: '2026-01-01', to: '' })).toBe(true);
  });
});

describe('sortDocuments', () => {
  it('drafts first, then issued documents newest number first; the input is not mutated', () => {
    const old = doc({ id: 'o', number: 10001 });
    const mid = doc({ id: 'm', number: 10004 });
    const input = [old, RFQ, mid, DRAFT];
    expect(sortDocuments(input).map((d) => d.id)).toEqual(['c', 'a', 'm', 'o']);
    expect(input.map((d) => d.id)).toEqual(['o', 'a', 'm', 'c']);
  });
  it('drafts: the newest document date first, then the newest created', () => {
    const d1 = doc({ id: 'd1', number: null, status: 'draft', doc_date: '2026-10-20', created_at: '2026-10-20T08:00:00.000Z' });
    const d2 = doc({ id: 'd2', number: null, status: 'draft', doc_date: '2026-10-20', created_at: '2026-10-20T09:00:00.000Z' });
    const d3 = doc({ id: 'd3', number: null, status: 'draft', doc_date: '2026-10-25', created_at: '2026-10-01T09:00:00.000Z' });
    expect(sortDocuments([d1, d2, d3]).map((d) => d.id)).toEqual(['d3', 'd2', 'd1']);
  });
  it('reads created_at as either a Date (first render) or an ISO string (after a reload)', () => {
    const asDate = doc({ id: 'x1', number: null, status: 'draft', created_at: new Date('2026-10-01T09:00:00Z') as unknown as string });
    const asText = doc({ id: 'x2', number: null, status: 'draft', created_at: '2026-10-01T08:00:00.000Z' });
    expect(sortDocuments([asText, asDate]).map((d) => d.id)).toEqual(['x1', 'x2']);
  });
});

describe('offersSummary', () => {
  it('everyone answered = all, nobody = none, otherwise some', () => {
    expect(offersSummary({ quote_count: 2, recipient_count: 2 })).toEqual({ received: 2, asked: 2, tone: 'all' });
    expect(offersSummary({ quote_count: 0, recipient_count: 2 })).toEqual({ received: 0, asked: 2, tone: 'none' });
    expect(offersSummary({ quote_count: 2, recipient_count: 3 })).toEqual({ received: 2, asked: 3, tone: 'some' });
  });
  it('a request nobody was asked is "0 מתוך 0", grey — never green', () => {
    expect(offersSummary({ quote_count: 0, recipient_count: 0 })).toEqual({ received: 0, asked: 0, tone: 'none' });
  });
  it('a quote typed in for a supplier outside the recipients still counts as asked', () => {
    expect(offersSummary({ quote_count: 3, recipient_count: 2 })).toEqual({ received: 3, asked: 3, tone: 'all' });
  });
});

describe('suppliersLine', () => {
  it('joins the recipients with a dot and skips unnamed ones', () => {
    expect(suppliersLine(RFQ)).toBe('חשמל כהן בע״מ · א.ב. אספקה טכנית');
    expect(suppliersLine({ parties: [{ key: 'k', name: '' }, { key: 'j', name: 'דשא פלוס' }] })).toBe('דשא פלוס');
    expect(suppliersLine({ parties: [] })).toBe('');
  });
});
