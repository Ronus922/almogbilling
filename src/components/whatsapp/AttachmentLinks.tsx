'use client';

import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileMeta, formatBytes } from '@/components/documents/helpers';
// The files of a broadcast (history table / mobile card / details header) or of
// one outbound message (the debtor's WhatsApp history): one chip per file (icon
// by MIME, name, size) that opens it through the authenticated proxy
// (/api/files/whatsapp-attachments/…). Renders nothing for a text-only row, so
// callers need no guard.

/** The minimum a chip needs — CampaignAttachmentView and
 *  WhatsAppMessageAttachment both satisfy it. */
export interface AttachmentChip {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  /** Authenticated proxy URL; '' renders the chip as plain text. */
  url: string;
  /** Marked as not delivered (a message attachment Green refused). */
  failed?: boolean;
}
export function AttachmentLinks({
  attachments,
  className,
}: {
  attachments: AttachmentChip[];
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
            title={a.failed ? `${a.original_name} — לא נשלח לנמען` : a.original_name}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
              a.failed
                ? 'border-red-200 bg-red-50 text-red-600 hover:border-red-300'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
            )}
          >
            <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded', tone)}>
              <Icon className="h-3 w-3" />
            </span>
            <span className="max-w-[160px] truncate">{a.original_name}</span>
            <span className="font-num tabular-nums text-slate-400">{formatBytes(a.size_bytes)}</span>
            {a.failed && <span className="shrink-0 font-semibold">· לא נשלח</span>}
          </a>
        );
      })}
    </div>
  );
}
