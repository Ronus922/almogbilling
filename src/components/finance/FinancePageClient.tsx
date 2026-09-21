'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CloudOff, Plus, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { KpiCard } from '@/components/KpiCard';
import { cn } from '@/lib/utils';
import { ils } from '@/lib/finance/format';
import { monthLabel } from '@/lib/finance/period';
import type { FinKind } from '@/lib/constants/finance';
import type { FinCategory, FinEntry, SupplierOption } from '@/lib/types/finance';
import { EntryGroupTable } from './EntryGroupTable';
import { EntrySheet } from './EntrySheet';
import { MonthPicker } from './MonthPicker';

// /finance — the monthly overview. Mounted with key={month} by the server page,
// so a month change is a fresh mount with fresh data (no effect-driven sync).

interface SheetState { open: boolean; kind: FinKind; entry: FinEntry | null }

function sums(entries: FinEntry[]) {
  let income = 0;
  let expense = 0;
  for (const e of entries) {
    if (e.kind === 'income') income += e.amount;
    else expense += e.amount;
  }
  return { income, expense, diff: income - expense };
}

function SectionTitle({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
      {children}
      <span className="font-num text-sm font-medium tabular-nums text-slate-400">{count}</span>
    </h2>
  );
}

export function FinancePageClient({
  month, entries: initialEntries, categories, suppliers, canEdit, driveConnected,
}: {
  month: string;
  entries: FinEntry[];
  categories: FinCategory[];
  suppliers: SupplierOption[];
  canEdit: boolean;
  driveConnected: boolean;
}) {
  const [entries, setEntries] = useState<FinEntry[]>(initialEntries);
  const [sheet, setSheet] = useState<SheetState>({ open: false, kind: 'expense', entry: null });
  const [sheetKey, setSheetKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<FinEntry | null>(null);

  const operating = useMemo(() => entries.filter((e) => e.category_section === 'operating'), [entries]);
  const renovation = useMemo(() => entries.filter((e) => e.category_section === 'renovation_fund'), [entries]);
  const op = sums(operating);
  const rf = sums(renovation);

  async function refresh() {
    try {
      const r = await fetch(`/api/finance/entries?m=${month}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { entries?: FinEntry[] };
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      toast.error(`רענון הנתונים נכשל: ${(err as Error).message}`);
    }
  }

  function openNew(kind: FinKind) {
    setSheetKey((k) => k + 1);
    setSheet({ open: true, kind, entry: null });
  }
  function openEdit(entry: FinEntry) {
    setSheetKey((k) => k + 1);
    setSheet({ open: true, kind: entry.kind, entry });
  }

  async function confirmDelete() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      const r = await fetch(`/api/finance/entries/${target.id}`, { method: 'DELETE', credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'מחיקה נכשלה');
      toast.success('השורה נמחקה');
      if (sheet.open && sheet.entry?.id === target.id) setSheet((s) => ({ ...s, open: false }));
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const hasActiveCategories = categories.some((c) => c.is_active);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">שקיפות כספית</h1>
          <p className="mt-1 text-sm text-muted-foreground">סקירה חודשית של הכנסות והוצאות הבניין — {monthLabel(month)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MonthPicker month={month} />
          {canEdit && (
            // Action group. A future "ייבוא כרטסת" button joins this row.
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => openNew('expense')} className="gap-2" disabled={!hasActiveCategories}>
                <Plus className="h-4 w-4" /> הוסף הוצאה
              </Button>
              <Button variant="approve" onClick={() => openNew('income')} className="gap-2" disabled={!hasActiveCategories}>
                <Plus className="h-4 w-4" /> הוסף הכנסה
              </Button>
            </div>
          )}
        </div>
      </header>

      {!hasActiveCategories && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          עדיין אין סעיפים. לפני ההזנה הראשונה יש להגדיר סעיפי הכנסה והוצאה ב
          <Link href="/finance/settings" className="font-semibold underline underline-offset-2">סעיפים והגדרות</Link>.
        </div>
      )}
      {canEdit && !driveConnected && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>
            Google Drive לא מחובר — קבצים שיצורפו יישמרו במערכת אך לא יגובו ל-Drive עד החיבור.{' '}
            <Link href="/finance/settings" className="font-semibold underline underline-offset-2">חבר Google Drive</Link>
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="הכנסות" value={ils(op.income)} subtitle="תקציב שוטף" tone="green" icon={TrendingUp} />
        <KpiCard title="הוצאות" value={ils(op.expense)} subtitle="תקציב שוטף" tone="red" icon={TrendingDown} />
        <KpiCard title="הפרש" value={ils(op.diff)} subtitle={op.diff < 0 ? 'גירעון בחודש' : 'עודף בחודש'} tone={op.diff < 0 ? 'amber' : 'cyan'} icon={Scale} />
      </div>

      <section className="space-y-3">
        <SectionTitle count={operating.filter((e) => e.kind === 'income').length}>הכנסות</SectionTitle>
        <EntryGroupTable
          kind="income"
          entries={operating.filter((e) => e.kind === 'income')}
          canEdit={canEdit}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          emptyText={`אין הכנסות ב${monthLabel(month)}.`}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle count={operating.filter((e) => e.kind === 'expense').length}>הוצאות</SectionTitle>
        <EntryGroupTable
          kind="expense"
          entries={operating.filter((e) => e.kind === 'expense')}
          canEdit={canEdit}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          emptyText={`אין הוצאות ב${monthLabel(month)}.`}
        />
      </section>

      <section className="space-y-4 rounded-2xl border border-line bg-white p-4 md:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">קרן שיפוצים</h2>
            <p className="text-sm text-muted-foreground">מנוהלת בנפרד מהתקציב השוטף ואינה נכללת בהפרש למעלה.</p>
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <div className="flex items-baseline gap-1.5"><dt className="text-ink-3">הכנסות</dt><dd dir="ltr" className="font-num font-bold tabular-nums text-emerald-700">{ils(rf.income)}</dd></div>
            <div className="flex items-baseline gap-1.5"><dt className="text-ink-3">הוצאות</dt><dd dir="ltr" className="font-num font-bold tabular-nums text-rose-700">{ils(rf.expense)}</dd></div>
            <div className="flex items-baseline gap-1.5"><dt className="text-ink-3">הפרש</dt><dd dir="ltr" className={cn('font-num font-bold tabular-nums', rf.diff < 0 ? 'text-amber-700' : 'text-ink')}>{ils(rf.diff)}</dd></div>
          </dl>
        </div>
        {renovation.length === 0 ? (
          <p className="py-2 text-center text-xs text-slate-400">אין תנועות בקרן השיפוצים החודש.</p>
        ) : (
          <div className="space-y-4">
            {renovation.some((e) => e.kind === 'income') && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700">הכנסות לקרן</h3>
                <EntryGroupTable kind="income" entries={renovation.filter((e) => e.kind === 'income')} canEdit={canEdit} onEdit={openEdit} onDelete={setDeleteTarget} emptyText="" />
              </div>
            )}
            {renovation.some((e) => e.kind === 'expense') && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700">הוצאות מהקרן</h3>
                <EntryGroupTable kind="expense" entries={renovation.filter((e) => e.kind === 'expense')} canEdit={canEdit} onEdit={openEdit} onDelete={setDeleteTarget} emptyText="" />
              </div>
            )}
          </div>
        )}
      </section>

      <EntrySheet
        key={sheetKey}
        open={sheet.open}
        kind={sheet.kind}
        entry={sheet.entry}
        defaultMonth={month}
        categories={categories}
        suppliers={suppliers}
        canEdit={canEdit}
        onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
        onSaved={() => void refresh()}
        onDelete={canEdit && sheet.entry ? () => setDeleteTarget(sheet.entry) : undefined}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את השורה?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${deleteTarget.kind === 'income' ? 'ההכנסה' : 'ההוצאה'} «${deleteTarget.category_name}» על סך ${ils(deleteTarget.amount)} תוסר מהסקירה. הקבצים המצורפים והגיבוי ב-Drive נשמרים.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()} className="bg-destructive text-white hover:bg-destructive/90">
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
