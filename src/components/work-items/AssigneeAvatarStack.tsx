'use client';

// תקלות/משימות — multi-assignee indicator (12/10/2026, addition beyond the
// reference per רונן's spec): a small overlapping avatar stack next to the
// primary assignee, names on hover. A card/row never duplicates across
// lanes — it shows once, at its primary assignee, with every OTHER assignee
// surfaced here. Matches the reference's `.av2` sizing (21px, -7px overlap,
// 2px white border) for the ones it already draws inside a card's footer.

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { avatarColorFor } from '@/lib/constants/workItems';
import type { WorkItemPrimaryAssignee } from '@/lib/types/workItems';

export function AssigneeAvatarStack({
  assignees,
  primary,
  size = 21,
}: {
  /** The full multi-assignee set (WorkItem.assignees). */
  assignees: WorkItemPrimaryAssignee[];
  /** The primary assignee — excluded from the stack (already shown by name). */
  primary: WorkItemPrimaryAssignee | null;
  size?: number;
}) {
  const others = assignees.filter((a) => !(primary && a.kind === primary.kind && a.id === primary.id));
  if (others.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex items-center" style={{ marginInlineStart: 'auto' }} />}>
        {others.map((a, i) => (
          <span
            key={`${a.kind}:${a.id}`}
            className="grid shrink-0 place-items-center rounded-full border-2 border-white text-[9px] font-bold text-white"
            style={{
              width: size,
              height: size,
              background: avatarColorFor(a.id),
              marginInlineStart: i === 0 ? 0 : -7,
            }}
          >
            {a.display_name.slice(0, 1)}
          </span>
        ))}
      </TooltipTrigger>
      <TooltipContent>{others.map((a) => a.display_name).join(', ')}</TooltipContent>
    </Tooltip>
  );
}
