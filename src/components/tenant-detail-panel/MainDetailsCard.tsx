'use client';

import { Home, Phone, Pencil } from 'lucide-react';
import { Section } from './Section';
import { formatPhoneDisplay } from '@/lib/phone';
import type { Tenant } from '@/types/tenant';
import type { PhoneField } from './EditPhoneDialog';

interface Props {
  tenant: Tenant;
  isAdmin: boolean;
  onEditPhone: (field: PhoneField) => void;
}

export function MainDetailsCard({ tenant, isAdmin, onEditPhone }: Props) {
  return (
    <Section title="פרטים עיקריים" icon={Home} iconTone="slate">
      <dl className="space-y-2.5 text-sm">
        <Row label="מספר דירה">
          <span className="text-lg font-bold text-slate-900">{tenant.apartment_number}</span>
        </Row>
        <Row label="בעל הדירה">
          <span className="font-semibold">{tenant.owner_name ?? '—'}</span>
        </Row>
        <PhoneRow
          label="טלפון בעלים"
          value={tenant.phone_owner}
          editable={isAdmin}
          onEdit={() => onEditPhone('phone_owner')}
        />
        <PhoneRow
          label="טלפון שוכר"
          value={tenant.phone_tenant}
          editable={isAdmin}
          onEdit={() => onEditPhone('phone_tenant')}
        />
      </dl>
    </Section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-lg font-extrabold text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function PhoneRow({ label, value, editable, onEdit }: {
  label: string;
  value: string | null;
  editable: boolean;
  onEdit: () => void;
}) {
  const display = formatPhoneDisplay(value);
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-lg font-extrabold text-muted-foreground">{label}</dt>
      <dd>
        <button
          type="button"
          onClick={editable ? onEdit : undefined}
          disabled={!editable}
          className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-semibold text-slate-900 hover:bg-slate-100 disabled:hover:bg-transparent disabled:cursor-default"
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
      </dd>
    </div>
  );
}
