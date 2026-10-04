'use client';

import { Plus, Trash2 } from 'lucide-react';
import { SupplierField, ReadonlyField } from './SupplierField';
import { validatePhone } from '@/lib/validation';
import { formatPhoneDisplay } from '@/lib/phone';
import type { SupplierContact, SupplierContactInput } from '@/lib/types/suppliers';

// "אנשי קשר נוספים" — the supplier's 2nd, 3rd… contact people (DESIGN.md §28.11).
// One implementation for the create panel, the edit form and view mode. A card
// has three fields — שם · טלפון נייד · אימייל (the one phone IS the mobile). The
// primary contact keeps its own fields exactly as they are; these cards sit
// after them, inside the same section grid, each spanning both columns.

/** One editable card. `key` is client-side only (saved rows get new ids on save). */
export interface SupplierContactRow {
  key: string;
  name: string;
  phone: string;
  email: string;
}

export type SupplierContactErrors = Map<string, { phone?: string; email?: string }>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let rowSeq = 0;

export function toContactRows(contacts: readonly SupplierContact[]): SupplierContactRow[] {
  return contacts.map((c) => ({
    key: `saved-${c.id}`, name: c.name, phone: c.phone, email: c.email,
  }));
}

/** Same rules as the supplier's own fields: validatePhone, plus the email format
 *  the server enforces. Empty fields are fine. */
export function supplierContactErrors(rows: readonly SupplierContactRow[]): SupplierContactErrors {
  const map: SupplierContactErrors = new Map();
  for (const r of rows) {
    const e: { phone?: string; email?: string } = {};
    if (r.phone.trim()) {
      const v = validatePhone(r.phone);
      if (!v.valid) e.phone = v.error ?? 'מספר טלפון לא תקין';
    }
    if (r.email.trim() && !EMAIL_RE.test(r.email.trim())) e.email = 'כתובת אימייל לא תקינה';
    if (e.phone || e.email) map.set(r.key, e);
  }
  return map;
}

/** The request body list — the whole list, in card order (the server drops blank rows). */
export function contactRowsPayload(rows: readonly SupplierContactRow[]): SupplierContactInput[] {
  return rows.map((r) => ({
    name: r.name.trim(),
    phone: r.phone.trim() ? validatePhone(r.phone).normalized : '',
    email: r.email.trim(),
  }));
}

const cardTitle = (index: number) => `איש קשר נוסף ${index + 2}`;

/** §28.11 card shell — §28.6 nested-item container; remove = §28.6 danger action at 44px. */
function ContactCard({
  title, onRemove, removeDisabled, children,
}: {
  title: string;
  onRemove?: () => void;
  removeDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className="space-y-[14px] rounded-[13px] border border-[#eef1f6] bg-[#fafbfd] px-4 py-[14px] sm:col-span-2"
    >
      <div className="flex min-h-[44px] items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold text-[#0f172a]">{title}</h3>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={removeDisabled}
            aria-label={`הסר ${title}`}
            className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-[9px] text-[#dc2626] transition-colors hover:bg-[#fef2f2] disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

interface EditorProps {
  /** Field-id prefix of the host panel: 'sup' (create) / 'esup' (edit). */
  idPrefix: string;
  rows: SupplierContactRow[];
  onChange: (rows: SupplierContactRow[]) => void;
  /** Shown as soon as a field is invalid (not after blur): the save button is
   *  disabled while any card has an error, so a blur-gated error could leave
   *  the user with a dead button and no explanation. Same as the apartment
   *  card's extra people. */
  errors: SupplierContactErrors;
  disabled: boolean;
}

/** The cards + the "הוסף איש קשר נוסף" button — rendered as direct children of
 *  the host section's 2-column grid (a fragment), so the grid gap spaces them. */
export function SupplierContactsEditor({
  idPrefix, rows, onChange, errors, disabled,
}: EditorProps) {
  function update(key: string, patch: Partial<Omit<SupplierContactRow, 'key'>>) {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function add() {
    rowSeq += 1;
    onChange([...rows, { key: `new-${rowSeq}`, name: '', phone: '', email: '' }]);
  }

  return (
    <>
      {rows.map((row, i) => {
        const id = `${idPrefix}-contact-${i}`;
        return (
          <ContactCard
            key={row.key}
            title={cardTitle(i)}
            onRemove={() => onChange(rows.filter((r) => r.key !== row.key))}
            removeDisabled={disabled}
          >
            <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
              <SupplierField
                id={`${id}-name`}
                label="שם"
                value={row.name}
                onChange={(v) => update(row.key, { name: v })}
                disabled={disabled}
                placeholder="שם איש הקשר"
              />
              <SupplierField
                id={`${id}-phone`}
                label="טלפון נייד"
                value={row.phone}
                onChange={(v) => update(row.key, { phone: v })}
                error={errors.get(row.key)?.phone ?? null}
                disabled={disabled}
                inputMode="tel"
                dir="ltr"
                tabularNums
                placeholder="052-1234567"
              />
              <SupplierField
                id={`${id}-email`}
                label="אימייל"
                type="email"
                value={row.email}
                onChange={(v) => update(row.key, { email: v })}
                error={errors.get(row.key)?.email ?? null}
                disabled={disabled}
                dir="ltr"
                placeholder="name@example.com"
              />
            </div>
          </ContactCard>
        );
      })}
      <div className="flex justify-start sm:col-span-2">
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          className="inline-flex h-[44px] items-center gap-2 rounded-[10px] border border-[#e2e8f0] bg-white px-4 text-[14px] font-semibold text-[#2563eb] transition-colors hover:bg-[#eff5ff] disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          הוסף איש קשר נוסף
        </button>
      </div>
    </>
  );
}

/** View mode — the same cards, read-only (no remove, no add). Renders nothing
 *  when the supplier has none. */
export function SupplierContactsView({ contacts }: { contacts: readonly SupplierContact[] }) {
  return (
    <>
      {contacts.map((c, i) => (
        <ContactCard key={c.id} title={cardTitle(i)}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ReadonlyField label="שם" value={c.name || null} />
            <ReadonlyField label="טלפון נייד" value={formatPhoneDisplay(c.phone)} ltr />
            <ReadonlyField label="אימייל" value={c.email || null} ltr accent />
          </div>
        </ContactCard>
      ))}
    </>
  );
}
