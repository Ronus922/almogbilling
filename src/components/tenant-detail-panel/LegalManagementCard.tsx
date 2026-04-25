'use client';

import { useState } from 'react';
import { Scale, User as UserIcon } from 'lucide-react';
import { Section } from './Section';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { Tenant, LegalStatus, LegalStatusId } from '@/types/tenant';

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

interface Props {
  tenant: Tenant;
  statuses: LegalStatus[];
  disabled?: boolean;
  onSaveLegalStatus: (id: LegalStatusId) => Promise<void>;
}

export function LegalManagementCard({ tenant, statuses, disabled, onSaveLegalStatus }: Props) {
  const [saving, setSaving] = useState(false);
  const currentId = tenant.legal_status_id ?? '';

  async function handleChange(id: string | null) {
    if (!id || id === currentId || saving) return;
    setSaving(true);
    try {
      await onSaveLegalStatus(id);
    } finally {
      setSaving(false);
    }
  }

  const updatedAt = formatDateTime(tenant.legal_status_updated_at);

  return (
    <Section title="ניהול משפטי" icon={Scale} iconTone="rose">
      <div className="space-y-3 pb-1">
        <div className="space-y-1.5">
          <Label className="text-base font-medium text-muted-foreground">סטטוס משפטי</Label>
          <Select value={currentId || undefined} onValueChange={handleChange} disabled={disabled || saving}>
            <SelectTrigger className="w-full data-[size=default]:h-10">
              <SelectValue placeholder="בחר סטטוס...">
                {(value: string | null) => {
                  if (!value) return null;
                  const s = statuses.find((x) => x.id === value);
                  if (!s) return value;
                  return (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-slate-900/10"
                        style={{ backgroundColor: s.color }}
                      />
                      {s.name}
                    </span>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {statuses.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-slate-900/10"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(updatedAt || tenant.legal_status_updated_by_name) && (
          <div className="border-t border-slate-100 pt-2.5 space-y-1 text-xs text-muted-foreground">
            {updatedAt && <div>עודכן לאחרונה: {updatedAt}</div>}
            {tenant.legal_status_updated_by_name && (
              <div className="inline-flex items-center gap-1">
                <UserIcon className="h-3 w-3" />
                על ידי: {tenant.legal_status_updated_by_name}
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
