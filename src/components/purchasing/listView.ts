// The pure rules of the /purchasing lists: what the search and the date range keep, the order the
// rows come in, and the colour of the "N מתוך M" offers pill. No I/O and no React, so the screen
// and tests/purchasing-list-view.test.ts read the same code.
import type { DocumentListItem } from './types';

export interface ListFilter {
  /** Free text: supplier, subject or number. */
  q: string;
  /** Document-date range, inclusive, `YYYY-MM-DD`; empty = open on that side. */
  from: string;
  to: string;
}

export const EMPTY_FILTER: ListFilter = { q: '', from: '', to: '' };

export const isFiltering = (f: ListFilter): boolean => f.q.trim() !== '' || f.from !== '' || f.to !== '';

const norm = (s: string): string => s.trim().toLocaleLowerCase('he-IL');

/** Everything the search reads on a row: its number, its subject and its suppliers (a request's
 *  recipients, an order's supplier). A draft has no number yet. */
function haystack(d: DocumentListItem): string {
  return norm([
    d.number === null ? '' : String(d.number),
    d.title ?? '',
    d.supplier_name ?? '',
    ...d.parties.map((p) => p.name),
  ].join('\n'));
}

export function matchesQuery(d: DocumentListItem, q: string): boolean {
  const needle = norm(q);
  return needle === '' || haystack(d).includes(needle);
}

/** `doc_date` is an ISO date, so the range is a plain string comparison. */
export function inDateRange(d: DocumentListItem, from: string, to: string): boolean {
  const day = (d.doc_date ?? '').slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function filterDocuments(rows: DocumentListItem[], f: ListFilter): DocumentListItem[] {
  return rows.filter((d) => matchesQuery(d, f.q) && inDateRange(d, f.from, f.to));
}

// `created_at` is typed as a string, but the server page hands the first render a Date (pg's
// timestamptz) while a reload brings an ISO string — `new Date()` reads both.
const stamp = (v: string): number => new Date(v).getTime();

const byNewestCreated = (a: DocumentListItem, b: DocumentListItem): number =>
  b.doc_date.localeCompare(a.doc_date) || stamp(b.created_at) - stamp(a.created_at);

/** Drafts first (they hold no number and are what the user is in the middle of), then the issued
 *  documents newest first — by number, which always grows. */
export function sortDocuments(rows: DocumentListItem[]): DocumentListItem[] {
  return [...rows].sort((a, b) => {
    const aDraft = a.status === 'draft';
    const bDraft = b.status === 'draft';
    if (aDraft !== bDraft) return aDraft ? -1 : 1;
    if (aDraft) return byNewestCreated(a, b);
    return (b.number ?? 0) - (a.number ?? 0) || byNewestCreated(a, b);
  });
}

export type OffersTone = 'all' | 'none' | 'some';

export interface OffersSummary { received: number; asked: number; tone: OffersTone }

/** "X מתוך Y": Y suppliers were asked (a quote typed in for someone who was not on the list still
 *  counts as asked), X quotes are in. Green when every supplier answered, grey when none did. */
export function offersSummary(d: Pick<DocumentListItem, 'quote_count' | 'recipient_count'>): OffersSummary {
  const received = d.quote_count;
  const asked = Math.max(d.recipient_count, d.quote_count);
  const tone: OffersTone = received === 0 ? 'none' : received === asked ? 'all' : 'some';
  return { received, asked, tone };
}

/** A request's suppliers as the second line under its subject. */
export const suppliersLine = (d: Pick<DocumentListItem, 'parties'>): string =>
  d.parties.map((p) => p.name).filter((n) => n !== '').join(' · ');
