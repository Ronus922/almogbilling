'use client';

import { Paperclip } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fileMeta, formatBytes } from '@/components/documents/helpers';
import { cn } from '@/lib/utils';
import type { FinDocumentView } from '@/lib/types/finance';
import { DriveStatusIcon } from './DriveStatusIcon';

/** The receipts of one entry: a paperclip + count that opens the list. Each
 *  file opens through the authenticated proxy; the Drive status sits beside it. */
export function EntryFilesPopover({ documents, size = 'sm' }: { documents: FinDocumentView[]; size?: 'sm' | 'lg' }) {
  if (documents.length === 0) return <span className="text-ink-ghost">—</span>;
  const worst = documents.some((d) => d.drive_status === 'failed')
    ? 'failed'
    : documents.some((d) => d.drive_status === 'pending') ? 'pending' : 'done';
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${documents.length} קבצים`}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-row-hover',
          size === 'lg' ? 'h-11' : 'h-9',
        )}
      >
        <Paperclip className="h-4 w-4 text-slate-400" />
        <span className="font-num tabular-nums">{documents.length}</span>
        <DriveStatusIcon status={worst} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-2" onClick={(e) => e.stopPropagation()}>
        <ul dir="rtl" className="space-y-1">
          {documents.map((d) => {
            const { Icon, tone } = fileMeta(d.mime);
            return (
              <li key={d.id} className="flex items-center gap-2 rounded-lg p-2 hover:bg-slate-50">
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', tone)}>
                  <Icon className="h-4 w-4" />
                </span>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm font-medium text-blue-700 hover:underline"
                  title={d.original_name}
                >
                  {d.original_name}
                </a>
                <span className="shrink-0 font-num text-xs tabular-nums text-slate-400">{formatBytes(d.size)}</span>
                <DriveStatusIcon status={d.drive_status} error={d.drive_error} attempts={d.drive_attempts} />
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
