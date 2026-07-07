import { cn } from '@/lib/utils';
import type { CampaignStatus, RecipientStatus } from '@/lib/wa-queue/types';
import { STATUS_META, RECIPIENT_STATUS_META } from '../_lib/status';

// Consistent status pill for the history table, details header and delivery log —
// one badge component, driven by the shared STATUS_META so labels/tones never drift.
export function CampaignStatusBadge({ status, className }: { status: CampaignStatus; className?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', m.cls, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

export function RecipientStatusBadge({ status, className }: { status: RecipientStatus; className?: string }) {
  const m = RECIPIENT_STATUS_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold', m.cls, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}
