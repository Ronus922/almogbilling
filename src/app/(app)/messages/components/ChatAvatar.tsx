'use client';

import { useState } from 'react';
import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';

// Conversation avatar shared by the list and the thread header. Renders the
// cached WhatsApp profile picture when present, with a hard fallback to the
// group icon / initials. The fallback is essential: Green API avatar URLs are
// expiring CDN links, so an <img> that 404s must degrade gracefully (onError).

function initials(title: string): string {
  return (
    title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}

export function ChatAvatar({
  title,
  isGroup,
  avatarUrl,
  className,
}: {
  title: string;
  isGroup: boolean;
  avatarUrl?: string | null;
  className?: string;
}) {
  // Track WHICH url failed (not a bare boolean): when avatarUrl changes to a new
  // value the failed state clears in the SAME render — no useEffect, no one-frame
  // fallback flash as the thread header switches between contacts.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = avatarUrl != null && failedUrl === avatarUrl;

  const box = cn('grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full', className);

  if (avatarUrl && !failed) {
    return (
      <span className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(avatarUrl)}
        />
      </span>
    );
  }

  if (isGroup) {
    return (
      <span className={cn(box, 'bg-sky-100 text-sky-600')}>
        <Users className="h-5 w-5" />
      </span>
    );
  }

  return (
    <span className={cn(box, 'bg-emerald-100 text-xs font-bold text-emerald-700')}>
      {initials(title)}
    </span>
  );
}
