'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pencil, PiggyBank, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ils } from '@/lib/finance/format';
import type { FinEntry, RenovationFundKpis, RenovationFundSettings } from '@/lib/types/finance';
import { FundLedgerTable } from './FundLedgerTable';
import { FundTargetDialog } from './FundTargetDialog';

// The "קרן שיפוצים" tab: cumulative over ALL months (no month picker) — the
// collection target with its progress, collected / spent / balance, the spend
// per purpose (every fund expense category, 0 ₪ included) and the whole
// ledger. Fund lines never touch the operating KPIs and vice versa.

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd dir="ltr" className={cn('mt-1 font-num text-xl font-bold tabular-nums', tone)}>{ils(value)}</dd>
    </div>
  );
}

export function FundTab({ kpis, canEdit, onEdit, onDelete, onTargetSaved }: {
  kpis: RenovationFundKpis;
  canEdit: boolean;
  onEdit: (e: FinEntry) => void;
  onDelete: (e: FinEntry) => void;
  onTargetSaved: (s: RenovationFundSettings) => void;
}) {
  const [target, setTarget] = useState(kpis.target_amount);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);

  const pct = target > 0 ? (kpis.collected / target) * 100 : 0;
  const pctShown = target > 0 ? `${(pct >= 100 ? Math.round(pct).toString() : pct.toFixed(1)).replace(/\.0$/, '')}%` : 'אין יעד';
  const width = Math.max(0, Math.min(100, pct));
  const maxPurpose = kpis.by_purpose.reduce((m, p) => Math.max(m, p.total), 0);

  return (
    <div className="space-y-6">
      {/* ── KPI card ─────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-line bg-white p-5 shadow-soft-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink-2">נגבה מתוך יעד</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span dir="ltr" className="font-num text-[26px] font-bold tracking-[-0.5px] text-emerald-700">{ils(kpis.collected)}</span>
              <span className="text-sm text-ink-3">מתוך</span>
              <span dir="ltr" className="font-num text-lg font-bold tabular-nums text-ink">{target > 0 ? ils(target) : '—'}</span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => { setDialogKey((k) => k + 1); setDialogOpen(true); }}
                  aria-label="עריכת יעד הגבייה"
                  title="עריכת יעד הגבייה"
                  className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-600"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#7c5cfc]/25 bg-[#f1ecff] text-[#7c5cfc]">
            <PiggyBank className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-ink-3">אחוז גבייה</span>
            <span className="font-num font-bold tabular-nums text-ink">{pctShown}</span>
          </div>
          <div
            role="progressbar"
            aria-label="אחוז גבייה מהיעד"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(width)}
            className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
          >
            <div className="h-full rounded-full bg-emerald-500 transition-all duration-300" style={{ width: `${width}%` }} />
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Metric label="נגבה" value={kpis.collected} tone="text-emerald-700" />
          <Metric label="יצא" value={kpis.spent} tone="text-rose-700" />
          <Metric label="יתרה בקרן" value={kpis.balance} tone={kpis.balance < 0 ? 'text-amber-700' : 'text-ink'} />
        </dl>
      </section>

      {/* ── Spend per purpose ─────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-line bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900">יצא לפי מטרה</h2>
          <Link href="/finance/settings#renovation-fund" className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50">
            <Settings2 className="h-4 w-4" aria-hidden /> ניהול מטרות
          </Link>
        </div>
        {kpis.by_purpose.length === 0 ? (
          <p className="mt-4 rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            אין מטרות עדיין. הוסף מטרות ב<Link href="/finance/settings#renovation-fund" className="font-semibold underline underline-offset-2">ניהול מטרות</Link>.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {kpis.by_purpose.map((p) => (
              <li key={p.category_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_160px]">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  <span className="truncate" title={p.name}>{p.name}</span>
                  {!p.is_active && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">מושבתת</span>}
                </span>
                <span dir="ltr" className="font-num text-sm font-bold tabular-nums text-rose-700 sm:order-3 sm:text-center">{ils(p.total)}</span>
                <span className="col-span-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 sm:col-span-1 sm:order-2" aria-hidden>
                  <span className="block h-full rounded-full bg-rose-400" style={{ width: `${maxPurpose > 0 ? (p.total / maxPurpose) * 100 : 0}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Ledger ───────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
          כל תנועות הקרן
          <span className="font-num text-sm font-medium tabular-nums text-slate-400">{kpis.entries.length}</span>
        </h2>
        <FundLedgerTable entries={kpis.entries} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} emptyText="אין עדיין תנועות בקרן השיפוצים." />
      </section>

      <FundTargetDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={target}
        onSaved={(s) => { setTarget(s.target_amount); onTargetSaved(s); }}
      />
    </div>
  );
}
