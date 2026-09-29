'use client';

import { Check, Home, Phone, Pencil, X } from 'lucide-react';
import { Section } from './Section';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { Tenant } from '@/types/tenant';
import type { PhoneField } from './EditPhoneDialog';
import {
  SUGGESTION_FIELD_IS_NUMERIC,
  type ContactFieldState, type ContactSuggestion, type SuggestionField,
} from '@/lib/types/contactSuggestions';

interface Props {
  tenant: Tenant;
  canEdit: boolean;
  onEditPhone: (field: PhoneField) => void;
  /** Open Bllink suggestions + who last changed each field (29/09/2026). */
  contactFields: ContactFieldState;
  onResolveSuggestion: (id: string, action: 'approve' | 'reject') => void;
}

export function MainDetailsCard({
  tenant, canEdit, onEditPhone, contactFields, onResolveSuggestion,
}: Props) {
  const suggestionFor = (field: SuggestionField): ContactSuggestion | null =>
    contactFields.suggestions.find((s) => s.field === field) ?? null;

  return (
    <Section title="פרטים עיקריים" icon={Home} iconTone="slate">
      <dl className="space-y-2.5 text-sm">
        <Row label="מספר דירה">
          <span className="text-lg font-bold text-slate-900">{tenant.apartment_number}</span>
        </Row>
        <Row
          label="בעל הדירה"
          source={contactFields.sources.owner_name}
          suggestion={suggestionFor('owner_name')}
          canEdit={canEdit}
          onResolve={onResolveSuggestion}
        >
          <span className="font-semibold">{tenant.owner_name ?? '—'}</span>
        </Row>
        <PhoneRow
          label="טלפון בעלים"
          value={tenant.phone_owner}
          editable={canEdit}
          onEdit={() => onEditPhone('phone_owner')}
          source={contactFields.sources.owner_phone}
          suggestion={suggestionFor('owner_phone')}
          onResolve={onResolveSuggestion}
        />
        {/* The tenant's name is drawn only when there is something to say —
            a value, a Bllink proposal or a provenance stamp. Most apartments
            have no tenant at all, and the card must not grow a permanent
            empty line for them. */}
        {(tenant.tenant_name || suggestionFor('tenant_name') || contactFields.sources.tenant_name) && (
          <Row
            label="שם שוכר"
            source={contactFields.sources.tenant_name}
            suggestion={suggestionFor('tenant_name')}
            canEdit={canEdit}
            onResolve={onResolveSuggestion}
          >
            <span className="font-semibold">{tenant.tenant_name ?? '—'}</span>
          </Row>
        )}
        <PhoneRow
          label="טלפון שוכר"
          value={tenant.phone_tenant}
          editable={canEdit}
          onEdit={() => onEditPhone('phone_tenant')}
          source={contactFields.sources.tenant_phone}
          suggestion={suggestionFor('tenant_phone')}
          onResolve={onResolveSuggestion}
        />
        {/* Addresses, on the same terms as the tenant's name: drawn only for
            an apartment that has one, a proposal for one, or a stamp on one.
            Bllink holds an address for 185 of the 290 apartments, so a
            permanent empty line would be wrong on both counts. */}
        <EmailRow
          label="מייל בעלים"
          value={tenant.email_owner}
          source={contactFields.sources.owner_email}
          suggestion={suggestionFor('owner_email')}
          canEdit={canEdit}
          onResolve={onResolveSuggestion}
        />
        <EmailRow
          label="מייל שוכר"
          value={tenant.email_tenant}
          source={contactFields.sources.tenant_email}
          suggestion={suggestionFor('tenant_email')}
          canEdit={canEdit}
          onResolve={onResolveSuggestion}
        />
      </dl>
    </Section>
  );
}

/** "ידני · 29.09" — deliberately quiet: an icon-free caption under the value,
 *  with the full sentence in the tooltip. Only a field someone actually
 *  changed carries one. */
function SourceMark({ source }: { source: NonNullable<ContactFieldState['sources']['owner_name']> }) {
  const label = source.source === 'manual' ? 'ידני' : 'בלינק';
  const d = new Date(source.updated_at);
  const short = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block w-fit" />}>
        <span className="text-[11px] text-slate-400">{label} · {short}</span>
      </TooltipTrigger>
      <TooltipContent>
        {source.source === 'manual' ? 'עודכן ידנית' : 'עודכן מסנכרון בלינק'} ב-{d.toLocaleDateString('he-IL')}
      </TooltipContent>
    </Tooltip>
  );
}

/** The open Bllink proposal for this field, with its two decisions in place.
 *  Rejecting keeps ours and stops that value coming back. */
function SuggestionTag({ suggestion, canEdit, onResolve }: {
  suggestion: ContactSuggestion;
  canEdit: boolean;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  const numeric = SUGGESTION_FIELD_IS_NUMERIC[suggestion.field];
  return (
    <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1">
      <span className="text-[11px] font-semibold text-amber-700">בלינק:</span>
      <span
        dir={numeric ? 'ltr' : undefined}
        className={cn('text-xs font-semibold text-amber-900', numeric && 'tabular-nums')}
      >
        {suggestion.proposed_value}
      </span>
      {canEdit && (
        <span className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={<button
                type="button"
                aria-label="אשר את ההצעה"
                onClick={() => onResolve(suggestion.id, 'approve')}
                className="rounded p-1 text-emerald-700 transition-colors hover:bg-emerald-100"
              />}
            >
              <Check className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>אשר — הערך ייכתב כאן</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<button
                type="button"
                aria-label="דחה את ההצעה"
                onClick={() => onResolve(suggestion.id, 'reject')}
                className="rounded p-1 text-rose-600 transition-colors hover:bg-rose-100"
              />}
            >
              <X className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>דחה — שלכם נשאר, וההצעה לא תחזור</TooltipContent>
          </Tooltip>
        </span>
      )}
    </div>
  );
}

function Row({ label, children, source, suggestion, canEdit = false, onResolve }: {
  label: string;
  children: React.ReactNode;
  source?: ContactFieldState['sources']['owner_name'];
  suggestion?: ContactSuggestion | null;
  canEdit?: boolean;
  onResolve?: (id: string, action: 'approve' | 'reject') => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-lg font-extrabold text-muted-foreground">{label}</dt>
        <dd className="text-start">
          {children}
          {source && <div className="text-end"><SourceMark source={source} /></div>}
        </dd>
      </div>
      {suggestion && onResolve && (
        <SuggestionTag suggestion={suggestion} canEdit={canEdit} onResolve={onResolve} />
      )}
    </div>
  );
}

/** An address, when there is one to show. Read-only here — the residents list
 *  is where an address is typed; this card shows what it holds and what
 *  Bllink proposes for it. */
function EmailRow({ label, value, source, suggestion, canEdit, onResolve }: {
  label: string;
  value: string | null;
  source?: ContactFieldState['sources']['owner_email'];
  suggestion: ContactSuggestion | null;
  canEdit: boolean;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  if (!value && !suggestion && !source) return null;
  return (
    <Row label={label} source={source} suggestion={suggestion} canEdit={canEdit} onResolve={onResolve}>
      {value ? (
        <a
          href={`mailto:${value}`}
          dir="ltr"
          className="font-semibold text-slate-900 underline-offset-2 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </Row>
  );
}

function PhoneRow({ label, value, editable, onEdit, source, suggestion, onResolve }: {
  label: string;
  value: string | null;
  editable: boolean;
  onEdit: () => void;
  source?: ContactFieldState['sources']['owner_name'];
  suggestion: ContactSuggestion | null;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  const display = formatPhoneDisplay(value);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-lg font-extrabold text-muted-foreground">{label}</dt>
        <dd>
          <button
            type="button"
            onClick={editable ? onEdit : undefined}
            disabled={!editable}
            className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-semibold text-slate-900 hover:bg-slate-100 disabled:cursor-default disabled:hover:bg-transparent"
            title={editable ? 'לחצו לעריכה' : ''}
          >
            {display ? (
              <span dir="ltr" className="tabular-nums">{display}</span>
            ) : (
              <span className="text-muted-foreground">אין</span>
            )}
            <Phone className="h-3.5 w-3.5 text-muted-foreground" />
            {editable && (
              <Pencil className="h-3 w-3 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </button>
          {source && <div className="pe-1.5 text-end"><SourceMark source={source} /></div>}
        </dd>
      </div>
      {suggestion && (
        <SuggestionTag suggestion={suggestion} canEdit={editable} onResolve={onResolve} />
      )}
    </div>
  );
}
