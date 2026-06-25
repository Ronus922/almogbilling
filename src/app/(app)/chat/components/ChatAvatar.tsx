'use client';

import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { initials, avatarTone } from './format';

// Internal-chat avatar — initials on a per-user soft tint (deterministic by
// name, matching the ref's multi-colour avatars). Group conversations get a
// people icon on indigo.
export function ChatAvatar({
  title,
  isGroup,
  online = false,
  className,
}: {
  title: string;
  isGroup: boolean;
  /** Show the green "online" dot (presence; emerald is the sanctioned exception). */
  online?: boolean;
  className?: string;
}) {
  const box = cn('grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full', className);

  const inner = isGroup ? (
    <span className={cn(box, 'bg-indigo-100 text-indigo-600')}>
      <Users className="h-5 w-5" />
    </span>
  ) : (
    <span className={cn(box, 'text-xs font-bold', avatarTone(title))}>{initials(title)}</span>
  );

  if (!online) return inner;
  return (
    <span className="relative inline-flex shrink-0">
      {inner}
      <span
        aria-label="מחובר"
        className="absolute bottom-0 end-0 h-3 w-3 rounded-full border-2 border-white bg-emerald-500"
      />
    </span>
  );
}
