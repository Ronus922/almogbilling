import 'server-only';
import type { Actor } from '@/lib/auth/actor';
import { appUrl } from '@/lib/config';
import {
  findDocument, getCompany, getSupplierBrief, listLines, listSupplierBriefs, logDispatch,
  ensureRecipient, type DocumentRow, type SupplierBrief,
} from '@/lib/db/purchasing';
import { resolveSendCreds } from '@/lib/db/whatsappInstances';
import { renderTemplate } from '@/lib/email-templates';
import { sendWithRetry } from '@/lib/email/send';
import { logger } from '@/lib/logger';
import { readPurchasingObject } from '@/lib/storage/purchasingStorage';
import {
  normalizePhone, sendWhatsAppFileByUrl, sendWhatsAppMessage, uploadWhatsAppFile, WhatsAppError,
} from '@/lib/whatsapp';
import { DOC_LABEL, docHeading, formatDocDate, type CompanySettings, type DocType } from './model';
import { renderDocumentPdf, type PdfInput, type PdfSupplier } from './pdf';

// Purchasing — the server-side orchestration of the two outputs of a document:
// its PDF, and its delivery to suppliers (e-mail with the PDF attached, and /
// or WhatsApp with the PDF as a file). Delivery reuses the app's existing
// channels (sendWithRetry / the Green API helpers) and records every attempt in
// purchasing_dispatches; it never throws for a single recipient's failure.

export interface BuiltPdf {
  bytes: Buffer;
  filename: string;
  doc: DocumentRow;
  company: CompanySettings;
}

/** The ASCII-safe download name; the Hebrew label rides in Content-Disposition
 *  filename* (see the route). */
export function pdfDownloadName(doc: Pick<DocumentRow, 'doc_type' | 'number'>): string {
  return `${DOC_LABEL[doc.doc_type]} ${doc.number}.pdf`;
}

export class CompanyMissingError extends Error {
  constructor() {
    super('company_missing');
    this.name = 'CompanyMissingError';
  }
}

async function loadImage(key: string | null): Promise<Uint8Array | null> {
  if (!key) return null;
  try {
    return await readPurchasingObject(key);
  } catch (err) {
    // A missing logo must not stop a document from being produced.
    logger.error('[purchasing] letterhead image unreadable', err);
    return null;
  }
}

/** Renders a document's PDF. `supplier` personalises the "לכבוד" block (a
 *  request is sent per supplier; a PO has its own supplier). */
export async function buildDocumentPdf(documentId: string, supplier?: SupplierBrief | null): Promise<BuiltPdf | null> {
  const doc = await findDocument(documentId);
  if (!doc) return null;
  const company = await getCompany();
  if (!company) throw new CompanyMissingError();
  const lines = await listLines(documentId);
  const listed = supplier ?? (doc.supplier_id ? await getSupplierBrief(doc.supplier_id) : null);
  // A supplier typed by hand has no row in `suppliers`: its details ride on the document.
  const to: PdfSupplier | null = listed
    ? { name: listed.name, address: listed.address, phone: listed.mobile || listed.phone }
    : doc.supplier_name
      ? { name: doc.supplier_name, address: doc.supplier_address ?? '', phone: doc.supplier_phone ?? '' }
      : null;
  const bytes = renderDocumentPdf({
    kind: doc.doc_type,
    number: doc.number,
    date: doc.doc_date,
    title: doc.title,
    notes: doc.notes,
    dueDate: doc.due_date,
    vatRate: doc.vat_rate,
    company,
    logo: await loadImage(company.logo_key),
    signature: await loadImage(company.signature_key),
    supplier: to,
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price })),
  });
  return { bytes, filename: pdfDownloadName(doc), doc, company };
}

export interface PreviewInput {
  doc_type: DocType;
  doc_date: string;
  title: string;
  notes: string;
  due_date: string | null;
  supplier: PdfSupplier | null;
  lines: PdfInput['lines'];
}

/** The PDF of a form that is not saved yet — same renderer, the number the
 *  document would get right now. Nothing is written. */
export async function buildPreviewPdf(input: PreviewInput, number: number): Promise<Buffer> {
  const company = await getCompany();
  if (!company) throw new CompanyMissingError();
  return renderDocumentPdf({
    kind: input.doc_type,
    number,
    date: input.doc_date,
    title: input.title,
    notes: input.notes,
    dueDate: input.due_date,
    vatRate: company.vat_rate,
    company,
    logo: await loadImage(company.logo_key),
    signature: await loadImage(company.signature_key),
    supplier: input.supplier,
    lines: input.lines,
  });
}

/** The personal public link of a supplier on a request. */
export function quoteLink(token: string): string {
  return `${appUrl()}/quote/${token}`;
}

export type Channel = 'email' | 'whatsapp';

export interface DispatchResult {
  supplier_id: string;
  supplier_name: string;
  channel: Channel;
  ok: boolean;
  error?: string;
}

function messageBody(doc: DocumentRow, company: CompanySettings, link: string | null): string {
  const heading = docHeading(doc.doc_type, doc.number);
  if (doc.doc_type === 'rfq') {
    return [
      'שלום רב,',
      '',
      doc.title ? `${company.name} מבקשת הצעת מחיר: ${doc.title}.` : `${company.name} מבקשת הצעת מחיר.`,
      `מצורף קובץ ${heading} עם פירוט הפריטים.`,
      '',
      'להגשת ההצעה (מחיר ליחידה לכל שורה) נא להיכנס לקישור האישי:',
      link ?? '',
      '',
      `ניתן להגיש ולתקן את ההצעה עד ${formatDocDate(doc.due_date)}.`,
      '',
      'תודה,',
      company.name,
    ].join('\n');
  }
  return [
    'שלום רב,',
    '',
    `מצורפת ${heading} מאת ${company.name}.`,
    doc.title ? `נושא: ${doc.title}` : '',
    '',
    'נא לאשר קבלה.',
    '',
    'תודה,',
    company.name,
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

async function sendEmail(
  doc: DocumentRow, company: CompanySettings, supplier: SupplierBrief, pdf: BuiltPdf, link: string | null,
): Promise<void> {
  if (!supplier.email.trim()) throw new Error('לספק אין כתובת מייל');
  const rendered = renderTemplate('broadcast', {
    subject: `${docHeading(doc.doc_type, doc.number)} — ${company.name}`,
    body: messageBody(doc, company, link),
  });
  await sendWithRetry({
    to: supplier.email.trim(),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    attachments: [{ filename: pdf.filename, content: pdf.bytes, contentType: 'application/pdf' }],
  });
}

async function sendWhatsApp(
  actor: Actor, doc: DocumentRow, company: CompanySettings, supplier: SupplierBrief, pdf: BuiltPdf, link: string | null,
): Promise<void> {
  const phone = normalizePhone(supplier.mobile || supplier.phone);
  const creds = await resolveSendCreds(actor, null);
  await sendWhatsAppMessage({
    instanceId: creds.greenInstanceId,
    token: creds.token,
    apiUrl: creds.apiUrl,
    chatId: phone.chatId,
    message: messageBody(doc, company, link),
  });
  // The PDF as a file: pushed to Green API's own storage (a 15-day link), so
  // nothing of ours is ever published.
  const { urlFile } = await uploadWhatsAppFile({
    instanceId: creds.greenInstanceId,
    token: creds.token,
    apiUrl: creds.apiUrl,
    mediaUrl: creds.mediaUrl,
    bytes: pdf.bytes,
    mimeType: 'application/pdf',
    fileName: `${doc.doc_type}-${doc.number}.pdf`,
  });
  await sendWhatsAppFileByUrl({
    instanceId: creds.greenInstanceId,
    token: creds.token,
    apiUrl: creds.apiUrl,
    chatId: phone.chatId,
    urlFile,
    fileName: pdf.filename,
    caption: docHeading(doc.doc_type, doc.number),
  });
}

/** Sends the document to each supplier over the chosen channels. A request
 *  gets each supplier's personal link (created on first send, reused after). */
export async function sendDocument(
  actor: Actor,
  documentId: string,
  supplierIds: string[],
  channels: { email: boolean; whatsapp: boolean },
): Promise<DispatchResult[]> {
  const first = await buildDocumentPdf(documentId);
  if (!first) return [];
  const { doc, company } = first;
  const suppliers = await listSupplierBriefs(supplierIds);
  const results: DispatchResult[] = [];

  for (const supplier of suppliers) {
    // One PDF per supplier: the "לכבוד" block carries their name.
    const pdf = (await buildDocumentPdf(documentId, supplier)) ?? first;
    const link = doc.doc_type === 'rfq' ? quoteLink((await ensureRecipient(documentId, supplier.id)).token) : null;

    for (const channel of ['email', 'whatsapp'] as const) {
      if (!channels[channel]) continue;
      let error: string | undefined;
      try {
        if (channel === 'email') await sendEmail(doc, company, supplier, pdf, link);
        else await sendWhatsApp(actor, doc, company, supplier, pdf, link);
      } catch (err) {
        error = err instanceof WhatsAppError || err instanceof Error ? err.message : 'שגיאה לא ידועה';
        logger.error(`[purchasing] ${channel} send failed`, { documentId, supplierId: supplier.id, error });
      }
      await logDispatch({
        document_id: documentId, supplier_id: supplier.id, channel,
        status: error ? 'failed' : 'sent', error: error ?? null, sent_by: actor.id,
      }).catch((e) => logger.error('[purchasing] dispatch log failed', e));
      results.push({ supplier_id: supplier.id, supplier_name: supplier.name, channel, ok: !error, error });
    }
  }
  return results;
}
