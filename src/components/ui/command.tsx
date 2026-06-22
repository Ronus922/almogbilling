'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

// Dependency-free command-palette primitives (no cmdk). Presentational + RTL,
// matching the project's design tokens; the consumer (GlobalSearch) owns the
// query state and keyboard navigation, passing `active`/`onSelect` per item.
// Mirrors the shadcn Command surface so call-sites read the same.

function CommandDialog({
  open,
  onOpenChange,
  label = 'חיפוש גלובלי',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dir="rtl"
        showCloseButton={false}
        className="top-[12vh] block w-[calc(100%-2rem)] max-w-[600px] -translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[600px]"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function Command({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="command" className={cn('flex flex-col overflow-hidden', className)} {...props} />;
}

const CommandInput = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  function CommandInput({ className, ...props }, ref) {
    return (
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="h-[18px] w-[18px] shrink-0 text-ink-3" aria-hidden />
        <input
          ref={ref}
          dir="rtl"
          className={cn(
            'h-[52px] w-full bg-transparent text-[14.5px] font-medium text-ink placeholder:text-ink-3 focus:outline-none',
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);

function CommandList({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-list"
      role="listbox"
      className={cn('max-h-[60vh] overflow-y-auto overflow-x-hidden p-2', className)}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-4 py-10 text-center text-[13px] font-medium text-ink-3', className)} {...props} />;
}

function CommandGroup({
  heading,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { heading?: string }) {
  return (
    <div data-slot="command-group" className={cn('mb-1', className)} {...props}>
      {heading && (
        <div className="px-2 pb-1 pt-2 text-[11px] font-extrabold tracking-[0.04em] text-ink-ghost">{heading}</div>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function CommandItem({
  active,
  onSelect,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onSelect'> & {
  active?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
        active ? 'bg-row-hover' : 'hover:bg-row-hover/60',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function CommandSeparator({ className }: { className?: string }) {
  return <div className={cn('my-1 h-px bg-line-soft', className)} aria-hidden />;
}

export {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
};
