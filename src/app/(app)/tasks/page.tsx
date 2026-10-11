import { redirect } from 'next/navigation';

// Unified תקלות/משימות module (11/10/2026) — /tasks now redirects to /work,
// preserving the ?task=<id> deep link (used by already-sent notifications,
// reminders and calendar links). The old screen's code (tasks-page-client.tsx
// etc.) stays in the repo, unlinked from the nav — see Decisions Log.
export default async function TasksPageRedirect({
  searchParams,
}: {
  searchParams: Promise<{ task?: string }>;
}) {
  const sp = await searchParams;
  redirect(sp.task ? `/work?kind=task&id=${encodeURIComponent(sp.task)}` : '/work');
}
