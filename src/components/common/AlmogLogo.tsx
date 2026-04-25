import { Headphones } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * ALMOG CRM wordmark + headset icon badge.
 * Matches the right-side card header in the Claude Design auth screens.
 */
export function AlmogLogo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div>
        <div className="text-xl font-extrabold leading-none tracking-tight">ALMOG CRM</div>
        <div className="mt-1 text-xs text-muted-foreground">ניהול דיירים וגבייה</div>
      </div>
      <div className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground">
        <Headphones className="h-5 w-5" aria-hidden />
      </div>
    </div>
  );
}
