// Download / print of a document's PDF from the detail window. A request's PDF is addressed to
// one supplier (`party` = its uuid or hand-typed key); a purchase order has no party.
import { toast } from 'sonner';
import { printPdf } from '@/lib/purchasing/printPdf';

export function pdfHref(id: string, party: string | null, download: boolean): string {
  const qs = new URLSearchParams();
  if (party) qs.set('party', party);
  if (download) qs.set('download', '1');
  const q = qs.toString();
  return `/api/purchasing/documents/${id}/pdf${q ? `?${q}` : ''}`;
}

export function downloadPdf(id: string, party: string | null): void {
  const a = document.createElement('a');
  a.href = pdfHref(id, party, true);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function printParty(id: string, party: string | null): Promise<void> {
  try {
    await printPdf(pdfHref(id, party, false));
  } catch {
    toast.error('ההדפסה נכשלה');
  }
}

export type PdfActionKind = 'download' | 'print';

export function runPdfAction(kind: PdfActionKind, id: string, party: string | null): void {
  if (kind === 'download') downloadPdf(id, party);
  else void printParty(id, party);
}
