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
import { resolveChipHolder } from '@/lib/chips/holder';
import type { ChipResidentRole, ChipWithHolder, ContactResidents } from '@/lib/types/chips';
import { cn } from '@/lib/utils';

interface Props {
  contactId: string | null;
  apartmentNumber: string;
  canEditChips: boolean;
}

interface ChipsPayload {
  items: ChipWithHolder[];
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

// Role pill tones — chips-skin ref families (same map as ChipsTable).
const ROLE_PILL: Record<ChipResidentRole, string> = {
  owner: 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]',
  tenant: 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet-ink)]',
  operator: 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
  staff: 'bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
  other: 'bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
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
    <div className="chips-skin space-y-4">
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

// Read-only row — deactivate/reactivate live in /chips, not here. The holder
// name resolves LIVE via resolveChipHolder (never holder_name directly) —
// an apartment can hold chips of several people in parallel (product rule 2).
function ChipRow({ chip }: { chip: ChipWithHolder }) {
  const active = chip.status === 'active';
  const holder = resolveChipHolder(chip);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3">
      <span
        className={cn(
          'chip-num text-sm font-semibold tracking-[0.02em]',
          active
            ? 'text-[var(--chip-green-ink)]'
            : 'text-[var(--chip-red-ink)] line-through decoration-[var(--chip-red-border)]',
        )}
      >
        {chip.chip_number}
      </span>
      <span className="text-[13px] font-bold text-[var(--chip-ink)]">{holder.name}</span>
      <span
        className={cn(
          'inline-flex h-[20px] items-center rounded-[6px] px-2 text-[11px] font-bold',
          ROLE_PILL[chip.resident_role],
        )}
      >
        {RESIDENT_ROLE_LABEL[chip.resident_role]}
      </span>
      {!holder.is_registry_linked && (
        <span className="inline-flex h-[20px] items-center rounded-[6px] border border-dashed border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] px-2 text-[11px] font-bold text-[var(--chip-ink-soft)]">
          לא במרשם
        </span>
      )}
      <span className="inline-flex h-[20px] items-center rounded-[6px] bg-[var(--chip-hover)] px-2 text-[11px] font-bold text-[var(--chip-ink-muted)]">
        {CHIP_TYPE_LABEL[chip.chip_type]}
      </span>
      <span
        className={cn(
          'inline-flex h-[20px] items-center gap-[5px] rounded-[6px] px-2 text-[11px] font-bold',
          active
            ? 'bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]'
            : 'bg-[var(--chip-red-soft)] text-[var(--chip-red-ink)]',
        )}
      >
        <span className={cn('h-[6px] w-[6px] rounded-full', active ? 'bg-[var(--chip-green)]' : 'bg-[var(--chip-red)]')} />
        {active ? 'פעיל' : 'לא פעיל'}
      </span>
      <span className="chip-num ms-auto text-xs text-[var(--chip-ink-soft)]">
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
