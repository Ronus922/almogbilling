import type { Metadata } from 'next';
import { SupplierQuoteForm } from '@/components/purchasing/SupplierQuoteForm';

export const runtime = 'nodejs';

// PUBLIC page (no login): the personal link a supplier receives for ONE request.
// Nothing is rendered server-side from the token — the form reads and writes
// through the rate-limited /api/public/quote/<token> routes, so this shell leaks
// nothing and a wrong token only ever shows "הקישור אינו תקף".
export const metadata: Metadata = {
  title: 'הגשת הצעת מחיר',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SupplierQuoteForm token={token} />;
}
