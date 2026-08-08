'use client';

// Chips tab of the tenant detail panel — read-only chip list for the linked
// contacts row (chip management lives in /chips) plus the "מי גר בדירה"
// resident-type selector. Issuing reuses IssueChipSheet locked to this
// apartment; every mutation here refetches from the contact endpoints.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Section } from './Section';
import { IssueChipSheet } from '@/components/chips/IssueChipSheet';
import { CHIP_TYPE_LABEL, RESIDENT_ROLE_LABEL } from '@/lib/constants/chips';
import type { Chip, ChipResidentRole, ContactResidents } from '@/lib/types/chips';
import { cn } from '@/lib/utils';

interface Props {
  contactId: string | null;
  apartmentNumber: string;
  canEditChips: boolean;
}

interface ChipsPayload {
  items: Chip[];
  active_count: number;
}

// contacts.resident_type (071) — who currently lives in the unit. Distinct
// vocabulary from RESIDENT_ROLE_LABEL (chip-holder roles incl. staff/other).
const RESIDENT_TYPES = ['owner', 'tenant', 'operator'] as const;

const RESIDENT_TYPE_LABEL: Record<string, string> = {
  owner: 'בעל הדירה',
  tenant: 'שוכר',
  operator: 'מפעיל',
};

// Role pill tones (DESIGN.md §10) — same map as ChipsTable.
const ROLE_PILL: Record<ChipResidentRole, string> = {
  owner: 'bg-blue-100 text-blue-700',
  tenant: 'bg-violet-100 text-violet-700',
  operator: 'bg-amber-100 text-amber-700',
  staff: 'bg-sky-100 text-sky-700',
  other: 'bg-slate-100 text-slate-600',
};

export function ChipsTab({ contactId, apartmentNumber, canEditChips }: Props) {
  const [chips, setChips] = useState<ChipsPayload | null>(null);
  const [residents, setResidents] = useState<ContactResidents | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingType, setSavingType] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/contacts/${contactId}/chips`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`chips HTTP ${r.status}`)))),
      fetch(`/api/contacts/${contactId}/residents`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`residents HTTP ${r.status}`)))),
    ])
      .then(([chipsRes, residentsRes]: [ChipsPayload, ContactResidents]) => {
        if (cancelled) return;
        setChips(chipsRes);
        setResidents(residentsRes);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contactId, reloadKey]);

  async function handleResidentTypeChange(value: string | null) {
    if (!contactId || !residents || !value || value === residents.resident_type || savingType) return;
    const previous = residents;
    setResidents({ ...residents, resident_type: value });
    setSavingType(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/resident-type`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ resident_type: value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      toast.success('עודכן');
    } catch (err) {
      setResidents(previous);
      const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה';
      toast.error(`עדכון נכשל: ${msg}`);
    } finally {
      setSavingType(false);
    }
  }

  // Apartment not linked to the contacts registry — nothing to show here.
  if (!contactId) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        הדירה אינה מקושרת למרשם הדיירים
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        שגיאה בטעינת הצ׳יפים: {error}
      </div>
    );
  }

  if (loading && !chips) {
    return (
      <div className="space-y-4">
        <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
        <div className="h-56 rounded-xl bg-muted/60 animate-pulse" />
      </div>
    );
  }

  const operator = residents?.residents.find((r) => r.role === 'operator') ?? null;
  const hasOperator = Boolean(operator && (operator.name || operator.phone));

  return (
    <div className="space-y-4">
      <Section title="מי גר בדירה" icon={Users} iconTone="violet">
        <div className="space-y-3 pb-1">
          <div className="space-y-1.5">
            <Label className="text-base font-medium text-muted-foreground">מתגורר בדירה</Label>
            <Select
              value={residents?.resident_type || undefined}
              onValueChange={handleResidentTypeChange}
              disabled={!canEditChips || savingType}
            >
              <SelectTrigger className="w-full data-[size=default]:h-10">
                <SelectValue placeholder="בחר...">
                  {(value: string | null) => (value ? RESIDENT_TYPE_LABEL[value] ?? value : null)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RESIDENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{RESIDENT_TYPE_LABEL[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasOperator && operator && (
            <div className="border-t border-slate-100 pt-2.5 space-y-1 text-sm text-slate-700">
              <div>מפעיל: {operator.name ?? '—'}</div>
              {operator.phone && (
                <div className="inline-flex items-center gap-1.5">
                  <span className="text-muted-foreground">טלפון:</span>
                  <span dir="ltr" className="font-num tabular-nums">{operator.phone}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section
        title="צ׳יפים"
        icon={KeyRound}
        iconTone="blue"
        headerSlot={canEditChips ? (
          <Button onClick={() => setIssueOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            הנפק צ׳יפ
          </Button>
        ) : undefined}
      >
        <div className="space-y-3 pb-1">
          <p className="text-sm text-slate-600">
            צ׳יפים פעילים:{' '}
            <span className="font-semibold text-slate-900">{chips?.active_count ?? 0}</span>
          </p>
          {chips && chips.items.length > 0 ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {chips.items.map((c) => <ChipRow key={c.id} chip={c} />)}
            </ul>
          ) : (
            <p className="text-xs text-slate-400 py-2 text-center">אין צ׳יפים לדירה זו עדיין.</p>
          )}
        </div>
      </Section>

      <IssueChipSheet
        open={issueOpen}
        onOpenChange={setIssueOpen}
        initial={{ contactId, apartmentNumber }}
        onIssued={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}

// Read-only row — deactivate/reactivate live in /chips, not here.
function ChipRow({ chip }: { chip: Chip }) {
  const active = chip.status === 'active';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3">
      <span dir="ltr" className="font-num text-sm font-semibold tabular-nums text-slate-900">
        {chip.chip_number}
      </span>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
          chip.chip_type === 'app' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-600',
        )}
      >
        {CHIP_TYPE_LABEL[chip.chip_type]}
      </span>
      {chip.resident_role && (
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
            ROLE_PILL[chip.resident_role],
          )}
        >
          {RESIDENT_ROLE_LABEL[chip.resident_role]}
        </span>
      )}
      <span
        className={cn(
          'inline-flex items-center gap-[5px] rounded-full px-2 py-0.5 text-xs font-semibold',
          active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600',
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-slate-400')} />
        {active ? 'פעיל' : 'מושבת'}
      </span>
      <span dir="ltr" className="ms-auto font-num text-xs tabular-nums text-slate-500">
        {formatDate(chip.issued_at)}
      </span>
    </li>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
}
