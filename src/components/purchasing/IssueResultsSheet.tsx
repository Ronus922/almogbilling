'use client';

// What happens right after a request is issued from its form. Channels ticked:
// the outcome per supplier and channel (a supplier without the e-mail / phone for
// a ticked channel is shown as skipped). Nothing ticked: the document was issued
// without sending, so each supplier gets its own PDF (addressed to it) to
// download or print.

import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Download, FileCheck2, Loader2, MinusCircle, Printer, X, XCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { printPdf } from '@/lib/purchasing/printPdf';

export interface IssueResult {
  supplier_id: string;
  supplier_name: string;
  channel: 'email' | 'whatsapp';
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface IssuedInfo {
  id: string;
  heading: string;
  parties: Array<{ key: string; name: string }>;
  /** null = nothing was ticked (issued without sending). */
  results: IssueResult[] | null;
  /** The send request itself failed (the document is issued all the same). */
  sendError: string | null;
}

interface Props {
  info: IssuedInfo | null;
  onClose: () => void;
}

const CHANNEL = { email: 'מייל', whatsapp: 'וואטסאפ' } as const;

export function IssueResultsSheet({ info, onClose }: Props) {
  const [printing, setPrinting] = useState<string | null>(null);
  useEscapeKey(!!info, onClose);

  async function print(key: string) {
    if (!info) return;
    setPrinting(key);
    try {
      await printPdf(`/api/purchasing/documents/${info.id}/pdf?party=${encodeURIComponent(key)}`);
    } catch {
      toast.error('ההדפסה נכשלה');
    } finally {
      setPrinting(null);
    }
  }

  return (
    <Sheet open={!!info} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="left" dir="rtl" showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">{info?.heading ?? ''} הופקה</SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">
                {info?.results ? 'תוצאות השליחה לספקים' : 'המסמך הופק בלי שליחה'}
              </p>
            </div>
            <button
              type="button" onClick={onClose} aria-label="סגור"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          {info?.sendError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" data-issue-send-error>
              המסמך הופק, אך השליחה נכשלה: {info.sendError}
            </p>
          )}

          {info && info.results === null && !info.sendError && (
            <Section title="PDF לכל ספק" icon={FileCheck2} iconTone="blue">
              <ul className="space-y-2 py-2" data-issue-pdf-list>
                {info.parties.map((p) => (
                  <li key={p.key} data-issue-supplier={p.key}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white p-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{p.name}</span>
                    <a
                      href={`/api/purchasing/documents/${info.id}/pdf?party=${encodeURIComponent(p.key)}&download=1`}
                      data-action="supplier-download"
                      className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-slate-50"
                    >
                      <Download className="h-4 w-4" aria-hidden /> הורד PDF
                    </a>
                    <button
                      type="button" onClick={() => print(p.key)} disabled={printing === p.key} data-action="supplier-print"
                      className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {printing === p.key ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Printer className="h-4 w-4" aria-hidden />} הדפס
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {info?.results && (
            <Section title="תוצאות השליחה" icon={FileCheck2} iconTone="violet">
              <ul className="space-y-2 py-2" data-issue-results>
                {info.results.map((r, i) => (
                  <li key={`${r.supplier_id}-${r.channel}-${i}`} className="flex items-start gap-3 rounded-lg border border-line bg-white p-3 text-sm">
                    {r.ok
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" aria-hidden />
                      : r.skipped
                        ? <MinusCircle className="mt-0.5 h-4 w-4 text-amber-600" aria-hidden />
                        : <XCircle className="mt-0.5 h-4 w-4 text-rose-600" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-ink">{r.supplier_name}</span>
                      <span className="text-ink-3"> · {CHANNEL[r.channel]}</span>
                      {r.skipped && <span className="block text-xs text-amber-700">דולג — {r.error}</span>}
                      {!r.ok && !r.skipped && <span className="block text-xs text-rose-600">{r.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button type="button" onClick={onClose} className="h-11 w-full sm:w-auto" data-action="issue-done">סגור</Button>
        </footer>
      </SheetContent>
    </Sheet>
  );
}
