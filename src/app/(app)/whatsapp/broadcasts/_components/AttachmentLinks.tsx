'use client';

import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileMeta, formatBytes } from '@/components/documents/helpers';
import type { CampaignAttachmentView } from '@/lib/wa-queue/types';

// The attachments of a broadcast as it appears in the history table / mobile
// card / details header: one chip per file (icon by MIME, name, size) that opens
// the file through the authenticated proxy (/api/files/whatsapp-attachments/…).
// Renders nothing for a text-only broadcast, so callers need no guard.
export function AttachmentLinks({
  attachments,
  className,
}: {
  attachments: CampaignAttachmentView[];
  className?: string;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
        <Paperclip className="h-3.5 w-3.5" />
        {attachments.length === 1 ? 'קובץ מצורף' : `${attachments.length} קבצים`}
      </span>
      {attachments.map((a) => {
        const { Icon, tone } = fileMeta(a.mime_type);
        return (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            title={a.original_name}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded', tone)}>
              <Icon className="h-3 w-3" />
            </span>
            <span className="max-w-[160px] truncate">{a.original_name}</span>
            <span className="font-num tabular-nums text-slate-400">{formatBytes(a.size_bytes)}</span>
          </a>
        );
      })}
    </div>
  );
}
