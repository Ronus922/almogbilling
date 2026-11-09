'use client';

import { Field } from '@/components/side-panel/Field';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type OcrField } from '@/lib/visitors/model';
import type { FormErrors, VisitorFormValues } from './format';

// The fields of one visitor row — shared by the scan sheet (create) and the
// detail sheet (an admin's edit), so the two cannot drift. Inputs follow
// DESIGN §6: the panel `Field` (h-10, red error state), a native date input.
//
// A field the OCR was unsure about gets an amber state and a one-line hint: the
// guard's second look goes where the model's doubt is, nowhere else.
//
// There is NO nationality field (Ronen, 09/11/2026): the column and the OCR's
// reading of it stay, the value rides along in `values` untouched (so a scan
// saves what the model read, and an admin's edit never blanks it), but no
// screen shows or edits it.

interface Props {
  values: VisitorFormValues;
  onChange: (patch: Partial<VisitorFormValues>) => void;
  errors?: FormErrors;
  /** OCR fields to flag for a second look. */
  lowConfidence?: ReadonlySet<OcrField>;
  disabled?: boolean;
}

const LOW_HINT = 'נקרא בביטחון נמוך — בדוק מול התעודה';

export function VisitorForm({ values, onChange, errors = {}, lowConfidence, disabled }: Props) {
  const low = (k: OcrField) => lowConfidence?.has(k) ?? false;
  const flagged = (k: OcrField, node: React.ReactNode) =>
    low(k) ? (
      <div className="[&_input]:border-amber-400 [&_input]:bg-amber-50 [&_p]:font-semibold [&_p]:text-amber-700">{node}</div>
    ) : (
      node
    );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-base font-medium text-muted-foreground">
          סוג המסמך<span className="text-red-500"> *</span>
        </Label>
        <div role="radiogroup" aria-label="סוג המסמך" className="grid grid-cols-3 gap-2">
          {DOCUMENT_TYPES.map((t) => {
            const active = values.document_type === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => onChange({ document_type: t })}
                className={cn(
                  'min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors',
                  active
                    ? 'border-brand bg-brand-soft text-brand-text'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  low('document_type') && 'border-amber-400 bg-amber-50',
                  errors.document_type && !active && 'border-red-400 bg-red-50',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                {DOCUMENT_TYPE_LABELS[t]}
              </button>
            );
          })}
        </div>
        {errors.document_type ? (
          <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {errors.document_type}</p>
        ) : low('document_type') ? (
          <p className="text-[12px] font-semibold text-amber-700 text-start">{LOW_HINT}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {flagged('first_name', (
          <Field id="v-first" label="שם פרטי" required value={values.first_name} disabled={disabled}
            onChange={(v) => onChange({ first_name: v })} error={errors.first_name}
            hint={low('first_name') ? LOW_HINT : undefined} />
        ))}
        {flagged('last_name', (
          <Field id="v-last" label="שם משפחה" required value={values.last_name} disabled={disabled}
            onChange={(v) => onChange({ last_name: v })} error={errors.last_name}
            hint={low('last_name') ? LOW_HINT : undefined} />
        ))}
        {flagged('document_number', (
          <Field id="v-docnum" label="מספר מסמך" required value={values.document_number} disabled={disabled}
            dir="ltr" tabularNums inputMode="text" onChange={(v) => onChange({ document_number: v })}
            error={errors.document_number} hint={low('document_number') ? LOW_HINT : undefined} />
        ))}
        {flagged('date_of_birth', (
          <Field id="v-dob" label="תאריך לידה" type="date" value={values.date_of_birth} disabled={disabled}
            dir="ltr" onChange={(v) => onChange({ date_of_birth: v })} error={errors.date_of_birth}
            hint={low('date_of_birth') ? LOW_HINT : undefined} />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="v-phone" label="טלפון" value={values.phone} disabled={disabled} dir="ltr" tabularNums
          inputMode="tel" onChange={(v) => onChange({ phone: v })} />
        <Field id="v-room" label="מספר חדר" value={values.room_number} disabled={disabled}
          onChange={(v) => onChange({ room_number: v })} />
        <Field id="v-chip" label="מספר צ׳יפ" value={values.chip_number} disabled={disabled} dir="ltr" tabularNums
          onChange={(v) => onChange({ chip_number: v })} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="v-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
        <Textarea id="v-notes" value={values.notes} disabled={disabled} rows={3} maxLength={2000}
          onChange={(e) => onChange({ notes: e.target.value })} className="min-h-20" />
      </div>
    </div>
  );
}
