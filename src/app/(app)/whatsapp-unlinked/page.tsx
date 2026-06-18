import { redirect } from 'next/navigation';

export const runtime = 'nodejs';

// The unlinked inbox was merged into /messages — unlinked conversations now show
// in the main conversation list (with a "לא משויך" label and an in-thread "שייך
// לדירה" action). This route is kept only as a redirect so old links/bookmarks
// don't 404.
export default function WhatsAppUnlinkedPage() {
  redirect('/messages');
}
