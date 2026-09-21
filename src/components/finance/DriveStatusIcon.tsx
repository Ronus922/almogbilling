'use client';

import { Cloud, CloudOff, CloudUpload } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FINANCE_DRIVE_MAX_ATTEMPTS, type DriveStatus } from '@/lib/constants/finance';

// The small Google Drive backup indicator shown next to every receipt
// (DESIGN.md §35): amber cloud-up = waiting, green cloud = backed up,
// red cloud-off = failed (the reason in the tooltip).
export function DriveStatusIcon({
  status, error, attempts, className,
}: {
  status: DriveStatus;
  error?: string | null;
  attempts?: number;
  className?: string;
}) {
  const meta =
    status === 'done'
      ? { Icon: Cloud, cls: 'text-emerald-600', text: 'גובה ל-Google Drive' }
      : status === 'failed'
        ? {
            Icon: CloudOff,
            cls: 'text-red-500',
            text:
              `הגיבוי ל-Google Drive נכשל${error ? `: ${error}` : ''}` +
              ((attempts ?? 0) >= FINANCE_DRIVE_MAX_ATTEMPTS ? ' · מוצו הניסיונות — "נסה שוב" בהגדרות' : ' · ינוסה שוב בשמירה הבאה'),
          }
        : { Icon: CloudUpload, cls: 'text-amber-500', text: 'ממתין לגיבוי ב-Google Drive' };
  const Icon = meta.Icon;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-grid h-5 w-5 shrink-0 place-items-center', className)} />}>
        <Icon className={cn('h-4 w-4', meta.cls)} aria-label={meta.text} />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-start">{meta.text}</TooltipContent>
    </Tooltip>
  );
}
