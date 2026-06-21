'use client';

import { useState } from 'react';
import { User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

// Conversation avatar shared by the list and the thread header. Renders the
// cached WhatsApp profile picture when present, with a hard fallback to the
// group icon / initials. The fallback is essential: Green API avatar URLs are
// expiring CDN links, so an <img> that 404s must degrade gracefully (onError).
//
// Fallback tone carries linkage state: a linked contact (debtor/supplier) gets
// the blue initials chip; an unlinked phone-only number gets a WhatsApp-style
// per-contact color from HASH_TONES (deterministic by identity). Blue is
// reserved for linked, sky for groups, so both are excluded from the palette.
const HASH_TONES = [
  'bg-[#e7f7ee] text-green-600',     // green  (#e7f7ee / #16a34a)
  'bg-amber-100 text-amber-700',     // amber  (#fef3c7 / #b45309)
  'bg-violet-100 text-violet-700',   // violet (#ede9fe / #6d28d9)
  'bg-rose-100 text-rose-600',
  'bg-teal-100 text-teal-700',
  'bg-orange-100 text-orange-700',
] as const;

/** Stable index into HASH_TONES from a contact seed (phone / title). */
function hashIndex(seed: string, len: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % len;
}

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
  linked = false,
  avatarUrl,
  className,
}: {
  title: string;
  isGroup: boolean;
  /** Linked to a debtor or supplier → blue initials chip; otherwise neutral. */
  linked?: boolean;
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

  // Unlinked phone-only number — WhatsApp-style per-contact color + user glyph.
  if (!linked) {
    return (
      <span className={cn(box, HASH_TONES[hashIndex(title, HASH_TONES.length)])}>
        <User className="h-5 w-5" />
      </span>
    );
  }

  // Linked contact — blue initials chip.
  return (
    <span className={cn(box, 'bg-blue-100 text-xs font-bold text-blue-700')}>
      {initials(title)}
    </span>
  );
}
