import { Scale } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  name: string;
  color: string;
  className?: string;
  showIcon?: boolean;
}

export function StatusBadge({ name, color, className, showIcon = true }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-slate-900 ring-1 ring-slate-900/5',
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {showIcon && <Scale className="h-3.5 w-3.5" />}
      {name}
    </span>
  );
}
