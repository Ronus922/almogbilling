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
  className,
}: {
  title: string;
  isGroup: boolean;
  className?: string;
}) {
  const box = cn('grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full', className);

  if (isGroup) {
    return (
      <span className={cn(box, 'bg-indigo-100 text-indigo-600')}>
        <Users className="h-5 w-5" />
      </span>
    );
  }

  return (
    <span className={cn(box, 'text-xs font-bold', avatarTone(title))}>
      {initials(title)}
    </span>
  );
}
