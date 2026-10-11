import { redirect } from 'next/navigation';

// Unified תקלות/משימות module (11/10/2026) — /issues now redirects to /work,
// preserving the ?issue=<id> deep link (used by already-sent notifications,
// reminders and calendar links). The old screen's code (issues-page-client.tsx,
// worker-issues-view.tsx etc.) stays in the repo, unlinked from the nav — see
// Decisions Log. Workers used to land here after login (lib/auth/home.ts) —
// that now points straight at /work, so this redirect is a compatibility path,
// not the worker's normal route.
export default async function IssuesPageRedirect({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string }>;
}) {
  const sp = await searchParams;
  redirect(sp.issue ? `/work?kind=issue&id=${encodeURIComponent(sp.issue)}` : '/work');
}
