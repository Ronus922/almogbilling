'use client';

import { useEffect, useState } from 'react';
import {
  Activity, Plus, Pencil, Archive, RotateCcw, Upload, FileText, Trash2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SupplierActivityEntry } from '@/lib/types/suppliers';

// Hebrew labels for the writable supplier fields (used by the 'updated' verb).
const FIELD_LABELS: Record<string, string> = {
  display_name: 'שם תצוגה',
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
  tone: string; // chip classes
}

const ACTION_META: Record<string, ActionMeta> = {
  created: { label: 'הספק נוצר', icon: Plus, tone: 'bg-emerald-100 text-emerald-700' },
  updated: { label: 'פרטים עודכנו', icon: Pencil, tone: 'bg-blue-100 text-blue-700' },
  archived: { label: 'הועבר לארכיון', icon: Archive, tone: 'bg-amber-100 text-amber-700' },
  restored: { label: 'שוחזר מארכיון', icon: RotateCcw, tone: 'bg-emerald-100 text-emerald-700' },
  document_uploaded: { label: 'מסמך הועלה', icon: Upload, tone: 'bg-blue-100 text-blue-700' },
  document_renamed: { label: 'שם מסמך שונה', icon: FileText, tone: 'bg-slate-100 text-slate-600' },
  document_deleted: { label: 'מסמך נמחק', icon: Trash2, tone: 'bg-rose-100 text-rose-600' },
};

function fallbackMeta(action: string): ActionMeta {
  return { label: action, icon: Activity, tone: 'bg-slate-100 text-slate-600' };
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
      <div className="rounded-xl bg-white p-12 text-center ring-1 ring-slate-200/70">
        <Activity className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm text-muted-foreground">אין עדיין פעילות מתועדת</p>
      </div>
    );
  }

  return (
    <ol className="space-y-2">
      {entries.map((entry) => {
        const meta = ACTION_META[entry.action] ?? fallbackMeta(entry.action);
        const Icon = meta.icon;
        const detail = describe(entry);
        return (
          <li
            key={entry.id}
            className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3"
          >
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', meta.tone)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm font-semibold text-slate-800">{meta.label}</span>
                <span dir="ltr" className="text-xs tabular-nums text-slate-400">
                  {formatDateTime(entry.created_at)}
                </span>
              </div>
              {detail && (
                <p className="mt-0.5 truncate text-sm text-slate-600" title={detail}>
                  {detail}
                </p>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {entry.actor_name ?? 'מערכת'}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
