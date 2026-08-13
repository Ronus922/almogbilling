'use client';

import { useEffect, useState } from 'react';
import {
  Activity, Plus, Pencil, Archive, RotateCcw, Upload, FileText, Trash2, User,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SupplierActivityEntry } from '@/lib/types/suppliers';

// Hebrew labels for the writable supplier fields (used by the 'updated' verb).
const FIELD_LABELS: Record<string, string> = {
  display_name: 'שם החברה',
  company_name: 'שם החברה',
  contact_person: 'איש קשר',
  supplier_type: 'סוג ספק',
  category_id: 'קטגוריה',
  status: 'סטטוס',
  phone: 'טלפון',
  mobile: 'נייד',
  email: 'אימייל',
  website: 'אתר',
  address: 'כתובת',
  city: 'עיר',
  tax_id: 'ח.פ / עוסק',
  bank_name: 'שם הבנק',
  bank_branch: 'סניף',
  bank_account: 'מספר חשבון',
  payment_terms: 'תנאי תשלום',
  notes: 'הערות',
  internal_notes: 'הערות פנימיות',
  rating: 'דירוג',
};

interface ActionMeta {
  label: string;
  icon: LucideIcon;
  tone: string; // node chip classes (light bg + colored icon) — reference §28.4
}

const ACTION_META: Record<string, ActionMeta> = {
  created: { label: 'הספק נוצר', icon: Plus, tone: 'bg-[#e7f7ee] text-[#16a34a]' },
  updated: { label: 'פרטים עודכנו', icon: Pencil, tone: 'bg-[#e8f0ff] text-[#2563eb]' },
  archived: { label: 'הועבר לארכיון', icon: Archive, tone: 'bg-[#fff3e6] text-[#ea8a18]' },
  restored: { label: 'שוחזר מארכיון', icon: RotateCcw, tone: 'bg-[#e7f7ee] text-[#16a34a]' },
  document_uploaded: { label: 'מסמך הועלה', icon: Upload, tone: 'bg-[#fff3e6] text-[#ea8a18]' },
  document_renamed: { label: 'שם מסמך שונה', icon: FileText, tone: 'bg-[#eef2f7] text-[#475569]' },
  document_deleted: { label: 'מסמך נמחק', icon: Trash2, tone: 'bg-[#ffe4e6] text-[#e11d48]' },
};

function fallbackMeta(action: string): ActionMeta {
  return { label: action, icon: Activity, tone: 'bg-[#eef2f7] text-[#475569]' };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** A human-readable detail line per action (null = no second line). */
function describe(entry: SupplierActivityEntry): string | null {
  const changes = asRecord(entry.changes);
  const metadata = asRecord(entry.metadata);

  switch (entry.action) {
    case 'updated': {
      const fields = Array.isArray(changes?.fields) ? (changes!.fields as string[]) : [];
      if (fields.length === 0) return null;
      return `עודכנו: ${fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}`;
    }
    case 'document_uploaded':
    case 'document_deleted':
      return typeof metadata?.file_name === 'string' ? (metadata.file_name as string) : null;
    case 'document_renamed': {
      const from = typeof metadata?.from === 'string' ? (metadata.from as string) : '';
      const to = typeof metadata?.to === 'string' ? (metadata.to as string) : '';
      return from && to ? `${from} ← ${to}` : null;
    }
    default:
      return null;
  }
}

function formatDateTime(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function SupplierActivity({
  supplierId,
  refreshSignal,
}: {
  supplierId: string;
  refreshSignal: number;
}) {
  const [entries, setEntries] = useState<SupplierActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/suppliers/${supplierId}/activity`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { activity?: SupplierActivityEntry[] }) => {
        if (!cancelled) setEntries(data.activity ?? []);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [supplierId, refreshSignal]);

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="h-16 rounded-xl bg-muted/60 animate-pulse" />
        <div className="h-16 rounded-xl bg-muted/60 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        טעינת יומן הפעילות נכשלה: {error}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-[14px] border border-[#e9edf4] bg-white p-12 text-center">
        <Activity className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm text-muted-foreground">אין עדיין פעילות מתועדת</p>
      </div>
    );
  }

  // DESIGN.md §28.4 activity timeline — heading + vertical rail + nodes + cards.
  return (
    <div>
      {/* section heading (violet icon + title + count) */}
      <div className="mb-5 flex items-center gap-[11px]">
        <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[#eef2ff] text-[#4f46e5]">
          <Activity className="h-[17px] w-[17px]" />
        </span>
        <div>
          <h2 className="text-lg font-extrabold text-slate-900">היסטוריית פעילות</h2>
          <p className="text-[13px] font-medium text-[#94a3b8]">{entries.length} אירועים אחרונים</p>
        </div>
      </div>

      <ol className="relative">
        {/* rail on the logical-start edge */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-[10px] bottom-[30px] right-[21px] w-0.5 bg-[linear-gradient(#dbe2ec,#eef1f6)]"
        />
        {entries.map((entry) => {
          const meta = ACTION_META[entry.action] ?? fallbackMeta(entry.action);
          const Icon = meta.icon;
          const detail = describe(entry);
          return (
            <li key={entry.id} className="relative flex items-stretch gap-[18px] pb-[14px] last:pb-0">
              <div className="z-[1] flex w-11 shrink-0 justify-center">
                <span
                  className={cn(
                    'grid h-11 w-11 place-items-center rounded-[13px] border-[3px] border-[#f4f6fb]',
                    meta.tone,
                  )}
                >
                  <Icon className="h-[19px] w-[19px]" />
                </span>
              </div>
              <div className="flex flex-1 items-start justify-between gap-4 rounded-[14px] border border-[#e9edf4] bg-white px-[18px] py-[15px] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                <div className="min-w-0 text-start">
                  <h3 className="text-[15.5px] font-bold text-[#0f172a]">{meta.label}</h3>
                  {detail && (
                    <p className="mt-[5px] truncate text-[13.5px] font-medium text-[#475569]" title={detail}>
                      {detail}
                    </p>
                  )}
                  <p className="mt-[7px] flex items-center gap-[5px] text-[12.5px] font-medium text-[#94a3b8]">
                    <User className="h-[13px] w-[13px] text-[#cbd5e1]" />
                    {entry.actor_name ?? 'מערכת'}
                  </p>
                </div>
                <span dir="ltr" className="shrink-0 whitespace-nowrap text-[12.5px] font-medium tabular-nums text-[#94a3b8]">
                  {formatDateTime(entry.created_at)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
