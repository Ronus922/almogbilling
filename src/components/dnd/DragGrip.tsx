import { cn } from '@/lib/utils';

/** The drag affordance of a card that can be dragged (issues kanban, reminders
 *  list): a 26px strip on the card's leading edge with a 2×3 dot grid. Visual
 *  only — the whole card stays draggable; `group-hover` darkens it with the
 *  card. */
export function DragGrip({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex w-[26px] flex-none items-center justify-center border-l border-slate-100 bg-slate-50 transition-colors group-hover:bg-slate-100',
        className,
      )}
      aria-hidden
    >
      <span className="grid grid-cols-2 gap-[3px]">
        {Array.from({ length: 6 }).map((_, d) => (
          <span key={d} className="h-1 w-1 rounded-full bg-slate-300 transition-colors group-hover:bg-slate-400" />
        ))}
      </span>
    </div>
  );
}
