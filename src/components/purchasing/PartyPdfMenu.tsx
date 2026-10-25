'use client';

// The PDF download / print button of the document window's bottom bar. A request with several
// suppliers addresses each PDF to one of them, so the button opens a small menu (a popover
// anchored to it — never a window) listing the suppliers; with one supplier (or a purchase
// order) it acts directly.

import { useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { runPdfAction, type PdfActionKind } from './pdfActions';

interface Props {
  kind: PdfActionKind;
  documentId: string;
  parties: Array<{ key: string; name: string }>;
  disabled?: boolean;
  className: string;
  children: ReactNode;
}

export function PartyPdfMenu({ kind, documentId, parties, disabled, className, children }: Props) {
  const [open, setOpen] = useState(false);
  const action = kind === 'download' ? 'download-pdf' : 'print';

  if (parties.length <= 1) {
    return (
      <button
        type="button" disabled={disabled} data-action={action} className={className}
        onClick={() => runPdfAction(kind, documentId, parties[0]?.key ?? null)}
      >
        {children}
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} data-action={action} className={className}>
        {children}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex min-w-52 flex-col gap-1 p-2" data-party-menu={kind}>
        <p className="px-3 py-1 text-xs font-semibold text-ink-3">{kind === 'download' ? 'הורדה עבור' : 'הדפסה עבור'}</p>
        {parties.map((p) => (
          <button
            key={p.key} type="button" data-party={p.key}
            onClick={() => { setOpen(false); runPdfAction(kind, documentId, p.key); }}
            className="flex min-h-11 items-center rounded-lg px-3 py-2 text-start text-sm font-semibold text-ink hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
          >
            {p.name || '—'}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
