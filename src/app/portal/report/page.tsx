import { redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/portal/session';
import { PortalIssueReport } from '@/components/portal/PortalIssueReport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /portal/report — "דיווח על תקלה" (ref/issue-report-form.md). Same gate as
// /portal: getPortalSession(), which also re-checks that the phone is still
// an active owner. Nothing is read for the screen — no apartment, no issue —
// the report is write-only and the server takes the reporter from the session.
export default async function PortalReportPage() {
  const session = await getPortalSession();
  if (!session) redirect('/portal/login');
  return <PortalIssueReport />;
}
