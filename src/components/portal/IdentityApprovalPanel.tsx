'use client';

// "אדם אחד" — approving that one phone, carrying several names, is ONE person
// (03/10/2026). The person with portal_manage picks the name the portal greets
// them by and, for EVERY apartment of the phone, how the person is connected
// to it. No default anywhere: the name starts empty (the names on the
// records are offered as one-click choices) and every apartment's relation
// must be chosen. A side panel (DESIGN.md §12 — creating a record), opened from
// the "טלפונים חסומים" screen and from the apartment card's "אותו אדם?".

import { useState } from 'react';
import { BadgeCheck, Building2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { PORTAL_ROLE_LABEL, type PortalRole } from '@/lib/portal/identity';
import { rosterPhoneDisplay } from '@/lib/portal/rosterLabels';
import { IDENTITY_RELATION_LABEL, type IdentityRelation } from '@/lib/types/portal';

export interface IdentityApprovalApartment {
  apartment_number: string;
  name: string | null;
  role: PortalRole;
}

export interface IdentityApprovalValue {
  display_name: string;
  apartments: { apartment_number: string; relation: IdentityRelation }[];
}

const RELATIONS = Object.keys(IDENTITY_RELATION_LABEL) as IdentityRelation[];

export function IdentityApprovalPanel({ open, phoneE164, apartments, busy, onOpenChange, onSubmit }: {
  open: boolean;
  phoneE164: string;
  /** Every apartment of the phone, lowest first. */
  apartments: IdentityApprovalApartment[];
  busy: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (value: IdentityApprovalValue) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [relations, setRelations] = useState<Record<string, IdentityRelation>>({});
  const names = [...new Set(apartments.map((a) => a.name?.trim()).filter((n): n is string => !!n))];
  const complete = displayName.trim() !== '' && apartments.every((a) => relations[a.apartment_number]);

  function close(o: boolean) {
    if (busy) return;
    if (!o) { setDisplayName(''); setRelations({}); }
    onOpenChange(o);
  }

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">אדם אחד</SheetTitle>
              <p className="mt-1 text-sm text-white/70">
                <span dir="ltr" className="font-num">{rosterPhoneDisplay(phoneE164)}</span>
                {' · '}הטלפון ייפתח בפורטל לכל הדירות תחת שם אחד. שם חדש שיתווסף אחר כך יחסום אותו שוב.
              </p>
            </div>
            <button
              type="button"
              onClick={() => close(false)}
              aria-label="סגור"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="שם תצוגה" icon={BadgeCheck} iconTone="blue">
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="identity-display-name" className="text-base font-medium text-muted-foreground">
                  השם שהפורטל יציג
                </Label>
                <Input
                  id="identity-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="h-10"
                  maxLength={120}
                  disabled={busy}
                />
              </div>
              {names.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {names.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setDisplayName(n)}
                      disabled={busy}
                      className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-blue-300 hover:bg-blue-50"
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title="הקשר לכל דירה" icon={Building2} iconTone="slate">
            <ul className="space-y-2">
              {apartments.map((a) => (
                <li key={a.apartment_number} className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">
                      דירה <span className="font-num">{a.apartment_number}</span>
                      <span className="font-normal text-slate-600"> · {PORTAL_ROLE_LABEL[a.role]}</span>
                    </p>
                    <p className="text-xs text-slate-500">{a.name ?? 'בלי שם'}</p>
                  </div>
                  <div className="sm:w-56">
                    <Select
                      value={relations[a.apartment_number] ?? null}
                      onValueChange={(v) => { if (v) setRelations((r) => ({ ...r, [a.apartment_number]: v as IdentityRelation })); }}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10" aria-label={`הקשר לדירה ${a.apartment_number}`}>
                        <SelectValue placeholder="בחר קשר…">
                          {(value: string | null) => (value ? IDENTITY_RELATION_LABEL[value as IdentityRelation] : null)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {RELATIONS.map((r) => (
                          <SelectItem key={r} value={r}>{IDENTITY_RELATION_LABEL[r]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <PanelFooter
          onClose={() => close(false)}
          onSave={() => onSubmit({
            display_name: displayName.trim(),
            apartments: apartments.map((a) => ({ apartment_number: a.apartment_number, relation: relations[a.apartment_number] })),
          })}
          saveLabel={busy ? 'שומר…' : 'אשר — אדם אחד'}
          saveDisabled={!complete || busy}
          saveDisabledReason={!complete ? 'יש לבחור שם תצוגה וקשר לכל דירה' : undefined}
        />
      </SheetContent>
    </Sheet>
  );
}
