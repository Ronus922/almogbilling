'use client';

import { useState } from 'react';
import { Scale, User as UserIcon } from 'lucide-react';
import { Section } from './Section';
import { Label } from '@/components/ui/label';
import { LegalStatusSelect } from '@/components/common/LegalStatusSelect';
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
          <LegalStatusSelect
            statuses={statuses}
            value={currentId}
            onValueChange={handleChange}
            disabled={disabled || saving}
          />
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
