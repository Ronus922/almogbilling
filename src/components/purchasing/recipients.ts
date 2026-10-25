// Client-side model of a request's suppliers on its form: a listed supplier
// (key = its uuid) or a hand-typed one (key = a form-made "m…" key). Details of
// a listed supplier are read from the suppliers list, never copied.
import type { DocumentDetail, SupplierBrief } from './types';

export interface PartyDraft {
  key: string;
  supplierId: string | null;
  name: string;
  /** Hand-typed suppliers only. */
  phone: string;
  email: string;
}

export const newManualKey = (): string => `m${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

export const partyFromSupplier = (s: SupplierBrief): PartyDraft => ({
  key: s.id, supplierId: s.id, name: s.name, phone: '', email: '',
});

export const typedParty = (name: string): PartyDraft => ({
  key: newManualKey(), supplierId: null, name, phone: '', email: '',
});

/** The suppliers a saved request / draft shows on its form: its recipients, else
 *  (a request from before several suppliers) the one on the document itself. */
export function partiesOfDetail(detail: DocumentDetail): PartyDraft[] {
  const recipients = detail.recipients ?? [];
  if (recipients.length > 0) {
    return recipients.map((r) => (r.supplier_id
      ? { key: r.supplier_id, supplierId: r.supplier_id, name: r.supplier_name, phone: '', email: '' }
      : {
          key: r.manual_key ?? newManualKey(), supplierId: null, name: r.supplier_name,
          phone: r.supplier_phone ?? '', email: r.supplier_email ?? '',
        }));
  }
  const d = detail.document;
  if (d.supplier_id) return [{ key: d.supplier_id, supplierId: d.supplier_id, name: d.supplier_name ?? '', phone: '', email: '' }];
  if (d.supplier_name) {
    return [{ key: newManualKey(), supplierId: null, name: d.supplier_name, phone: d.supplier_phone ?? '', email: d.supplier_email ?? '' }];
  }
  return [];
}

/** What a party lacks for the channels that are ticked ("" = nothing). */
export function missingForChannels(
  p: PartyDraft, suppliers: readonly SupplierBrief[], sendEmail: boolean, sendWhatsapp: boolean,
): string {
  const listed = p.supplierId ? suppliers.find((s) => s.id === p.supplierId) : null;
  const email = (listed ? listed.email : p.email).trim();
  const phone = (listed ? listed.mobile || listed.phone : p.phone).trim();
  const missing: string[] = [];
  if (sendEmail && !email) missing.push('מייל');
  if (sendWhatsapp && !phone) missing.push('טלפון');
  return missing.length ? `אין ${missing.join(' ו')}` : '';
}

/** The `recipients` of the API body. */
export const recipientsPayload = (parties: readonly PartyDraft[]) => parties.map((p) => (p.supplierId
  ? { supplier_id: p.supplierId, key: null }
  : { supplier_id: null, key: p.key, name: p.name.trim(), phone: p.phone.trim(), email: p.email.trim() }));

export const EMAIL_RE = /^\S+@\S+\.\S+$/;
