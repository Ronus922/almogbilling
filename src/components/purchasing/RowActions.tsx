'use client';

// The quick actions at the end of a list row — download PDF, print, send — and
// the delete icon of a draft. A request with several suppliers addresses each PDF
// to one supplier, so there the PDF / print icons open a small menu (a popover
// anchored to the icon, never a window) that lists them. A draft has no PDF and
// no send yet: its icons are disabled.

import { useState } from 'react';
import { Download, Printer, Send, Trash2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { printPdf } from '@/lib/purchasing/printPdf';
import { cn } from '@/lib/utils';
import type { DocumentListItem } from './types';

type ActionKind = 'download' | 'print';

const ICON_CLASS = 'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors';
const ENABLED_CLASS = 'hover:bg-row-hover hover:text-ink focus-visible:bg-row-hover focus-visible:text-ink focus-visible:outline-none';
const DISABLED_CLASS = 'cursor-not-allowed opacity-40';

const META: Record<ActionKind | 'send', { label: string; Icon: LucideIcon }> = {
  download: { label: 'הורדת PDF', Icon: Download },
  print: { label: 'הדפסה', Icon: Printer },
  send: { label: 'שליחה', Icon: Send },
};

function pdfUrl(id: string, partyKey: string | null, download: boolean): string {
  const qs = new URLSearchParams();
  if (partyKey) qs.set('party', partyKey);
  if (download) qs.set('download', '1');
  const q = qs.toString();
  return `/api/purchasing/documents/${id}/pdf${q ? `?${q}` : ''}`;
}

function downloadPdf(id: string, partyKey: string | null) {
  const a = document.createElement('a');
  a.href = pdfUrl(id, partyKey, true);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function print(id: string, partyKey: string | null) {
  try {
    await printPdf(pdfUrl(id, partyKey, false));
  } catch {
    toast.error('ההדפסה נכשלה');
  }
}

function run(kind: ActionKind, id: string, partyKey: string | null) {
  if (kind === 'download') downloadPdf(id, partyKey);
  else void print(id, partyKey);
}

function PartyMenu({ kind, doc }: { kind: ActionKind; doc: DocumentListItem }) {
  const [open, setOpen] = useState(false);
  const { label, Icon } = META[kind];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label} title={label} data-row-action={kind}
        className={cn(ICON_CLASS, ENABLED_CLASS, open && 'bg-row-hover text-ink')}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex min-w-48 flex-col gap-1 p-2" data-party-menu={kind}>
        <p className="px-3 py-1 text-xs font-semibold text-ink-3">{kind === 'download' ? 'הורדה עבור' : 'הדפסה עבור'}</p>
        {doc.parties.map((p) => (
          <button
            key={p.key}
            type="button"
            data-party={p.key}
            onClick={() => { setOpen(false); run(kind, doc.id, p.key); }}
            className="flex min-h-11 items-center rounded-lg px-3 py-2 text-start text-sm font-semibold text-ink hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
          >
            {p.name || '—'}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function IconButton({ kind, disabled, onClick }: { kind: ActionKind | 'send'; disabled?: boolean; onClick: () => void }) {
  const { label, Icon } = META[kind];
  return (
    <button
      type="button" aria-label={label} title={label} data-row-action={kind}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onClick(); }}
      className={cn(ICON_CLASS, disabled ? DISABLED_CLASS : ENABLED_CLASS)}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

interface Props {
  doc: DocumentListItem;
  /** The user may edit this tab's documents: sees the send icon and deletes drafts. */
  canEdit: boolean;
  onSend: (id: string) => void;
  onDeleteDraft: (id: string) => void;
}

export function RowActions({ doc, canEdit, onSend, onDeleteDraft }: Props) {
  const draft = doc.status === 'draft';
  const multi = doc.doc_type === 'rfq' && doc.parties.length > 1;
  const single = doc.doc_type === 'rfq' && doc.parties.length === 1 ? doc.parties[0].key : null;

  return (
    // Nothing in here may reach the row: not its click, double-click nor Enter / Space.
    <div
      className="flex items-center justify-end gap-1"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {(['download', 'print'] as const).map((kind) =>
        multi && !draft ? (
          <PartyMenu key={kind} kind={kind} doc={doc} />
        ) : (
          <IconButton key={kind} kind={kind} disabled={draft} onClick={() => run(kind, doc.id, single)} />
        ),
      )}
      {canEdit && <IconButton kind="send" disabled={draft} onClick={() => onSend(doc.id)} />}
      {canEdit && draft && (
        <button
          type="button" aria-label="מחיקת הטיוטה" title="מחיקת הטיוטה" data-delete-draft
          onClick={() => onDeleteDraft(doc.id)}
          className={cn(ICON_CLASS, 'hover:bg-rose-50 hover:text-rose-600')}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
