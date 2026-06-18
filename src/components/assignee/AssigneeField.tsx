'use client';

// Shared "handler" (גורם מטפל) picker for issues & tasks — the mutually-exclusive
// assignee model: a 3-way type selector (ללא שיוך / עובד פנימי / ספק חיצוני) over a
// searchable Combobox (users or suppliers), with a clickable phone for a supplier.
// Controlled (value/onChange), mirroring the shared TargetField pattern. Switching
// type clears the other side's selection.

import { User, Wrench, Phone } from 'lucide-react';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import { formatPhoneDisplay, phoneTelHref } from '@/lib/phone';
import type {
  AssigneeType, AssigneeOption, SupplierOption, AssigneeValue,
} from '@/lib/types/assignee';

interface Props {
  value: AssigneeValue;
  onChange: (v: AssigneeValue) => void;
  users: AssigneeOption[];
  suppliers: SupplierOption[];
  /** Display name for a linked supplier that may be soft-deleted (and thus absent
   *  from `suppliers`) — keeps the trigger label correct in edit mode. */
  supplierFallbackLabel?: string | null;
  disabled?: boolean;
}

export function AssigneeField({
  value, onChange, users, suppliers, supplierFallbackLabel, disabled = false,
}: Props) {
  // Switching the handler type clears the other side's selection (mutual model).
  function setType(t: AssigneeType) {
    onChange({
      type: t,
      userId: t === 'user' ? value.userId : null,
      supplierId: t === 'supplier' ? value.supplierId : null,
    });
  }

  const selectedSupplierPhone =
    suppliers.find((s) => s.id === value.supplierId)?.phone ?? null;

  return (
    <div className="space-y-3">
      {/* Type selector */}
      <div className="inline-flex w-full gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
        <AssigneeTypeButton active={value.type === 'none'} onClick={() => setType('none')} disabled={disabled}>
          ללא שיוך
        </AssigneeTypeButton>
        <AssigneeTypeButton active={value.type === 'user'} onClick={() => setType('user')} disabled={disabled} icon={User}>
          עובד פנימי
        </AssigneeTypeButton>
        <AssigneeTypeButton active={value.type === 'supplier'} onClick={() => setType('supplier')} disabled={disabled} icon={Wrench}>
          ספק חיצוני
        </AssigneeTypeButton>
      </div>

      {/* Matching searchable picker */}
      {value.type === 'user' && (
        <Combobox
          value={value.userId || null}
          onChange={(v) => onChange({ ...value, userId: v })}
          options={users.map((u) => ({ value: u.id, label: u.name }))}
          placeholder="בחר עובד…"
          searchPlaceholder="חיפוש עובד…"
          emptyText="לא נמצאו עובדים"
          disabled={disabled}
        />
      )}

      {value.type === 'supplier' && (
        <div className="space-y-2">
          <Combobox
            value={value.supplierId || null}
            onChange={(v) => onChange({ ...value, supplierId: v })}
            options={suppliers.map((s) => ({ value: s.id, label: s.display_name, keywords: s.phone }))}
            placeholder="בחר ספק…"
            searchPlaceholder="חיפוש ספק…"
            emptyText="לא נמצאו ספקים"
            fallbackLabel={supplierFallbackLabel ?? undefined}
            disabled={disabled}
          />
          {selectedSupplierPhone && phoneTelHref(selectedSupplierPhone) && (
            <a
              href={`tel:${phoneTelHref(selectedSupplierPhone)}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
              dir="ltr"
            >
              <Phone className="h-3.5 w-3.5" />
              <span className="tabular-nums">{formatPhoneDisplay(selectedSupplierPhone)}</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** One segment of the handler-type selector (ללא / עובד / ספק). */
function AssigneeTypeButton({
  active, onClick, disabled, icon: Icon, children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon?: typeof User;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        active
          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
          : 'text-slate-500 hover:text-slate-700',
      )}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </button>
  );
}
