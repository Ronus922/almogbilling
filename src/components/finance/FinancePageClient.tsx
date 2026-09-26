'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CloudOff, Eye, Plus, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { KpiCard } from '@/components/KpiCard';
import { ils } from '@/lib/finance/format';
import { currentMonthKey, periodLabel, type Period } from '@/lib/finance/period';
import type { FinKind, FinSection } from '@/lib/constants/finance';
import type {
  FinCategory, FinEntry, FinMonthStatus, PeriodReport, RenovationFundKpis, SupplierOption,
} from '@/lib/types/finance';
import { EntryGroupTable } from './EntryGroupTable';
import { EntrySheet } from './EntrySheet';
import { FinanceTabs, type FinanceTab } from './FinanceTabs';
import { FundTab } from './FundTab';
import { PeriodPicker } from './PeriodPicker';
import { PeriodReportView } from './PeriodReportView';
import { PublishToggle } from './PublishToggle';
import { ResidentViewToggle } from './ResidentViewToggle';

// /finance — two tabs. "שוטף": the period picker, then either one month (the
// KPIs + the income / expense tables + the publish switch) or a period report.
// "קרן שיפוצים": cumulative, no month picker. Mounted with key={tab:period} by
// the server page, so a tab / period change is a fresh mount with fresh data;
// after a save or delete the page asks the server to re-render (router.refresh).

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
  tab, period, entries, monthStatus, report, fund, publishedMonths, categories, suppliers, canEdit, driveConnected,
}: {
  tab: FinanceTab;
  period: Period;
  /** Operating lines of the month (month mode only). */
  entries: FinEntry[];
  monthStatus: FinMonthStatus | null;
  report: PeriodReport | null;
  fund: RenovationFundKpis | null;
  publishedMonths: string[];
  categories: FinCategory[];
  suppliers: SupplierOption[];
  canEdit: boolean;
  driveConnected: boolean;
}) {
  const router = useRouter();
  const [sheet, setSheet] = useState<SheetState>({ open: false, kind: 'expense', entry: null });
  const [sheetKey, setSheetKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<FinEntry | null>(null);
  const [published, setPublished] = useState(monthStatus?.published ?? false);

  const isFund = tab === 'fund';
  const section: FinSection = isFund ? 'renovation_fund' : 'operating';
  const isMonth = !isFund && period.kind === 'month';
  const op = sums(entries);

  const hasActive = (kind: FinKind) => categories.some((c) => c.is_active && c.section === section && c.kind === kind);
  const hasAnyOfSection = categories.some((c) => c.is_active && c.section === section);

  const refresh = () => router.refresh();

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
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const subtitle = isFund
    ? 'קרן השיפוצים — מצטבר מכל החודשים, מחוץ לתקציב השוטף.'
    : isMonth
      ? `סקירה חודשית של הכנסות והוצאות הבניין — ${periodLabel(period)}`
      : `דוח תקופה של התקציב השוטף — ${periodLabel(period)}`;

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">שקיפות כספית</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FinanceTabs active={tab} />
            <ResidentViewToggle active={false} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {isFund ? (
            <span />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <PeriodPicker period={period} publishedMonths={publishedMonths} />
              {isMonth && monthStatus && (
                <PublishToggle
                  month={period.key}
                  status={monthStatus}
                  canEdit={canEdit}
                  // Re-render the server data too, so the picker's green dots follow.
                  onChange={(s) => { setPublished(s.published); refresh(); }}
                />
              )}
            </div>
          )}
          {canEdit && (
            // Action group. A future "ייבוא כרטסת" button joins this row.
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => openNew('expense')} className="gap-2" disabled={!hasActive('expense')}>
                <Plus className="h-4 w-4" /> {isFund ? 'הוצאה מהקרן' : 'הוסף הוצאה'}
              </Button>
              <Button variant="approve" onClick={() => openNew('income')} className="gap-2" disabled={!hasActive('income')}>
                <Plus className="h-4 w-4" /> {isFund ? 'הפקדה לקרן' : 'הוסף הכנסה'}
              </Button>
            </div>
          )}
        </div>
      </header>

      {!hasAnyOfSection && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          {isFund ? (
            <>
              עדיין אין מטרות או סעיפי הפקדה לקרן. לפני ההזנה הראשונה יש להגדיר אותם ב
              <Link href="/finance/settings#renovation-fund" className="font-semibold underline underline-offset-2">ניהול מטרות</Link>.
            </>
          ) : (
            <>
              עדיין אין סעיפים. לפני ההזנה הראשונה יש להגדיר סעיפי הכנסה והוצאה ב
              <Link href="/finance/settings" className="font-semibold underline underline-offset-2">סעיפים והגדרות</Link>.
            </>
          )}
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

      {isMonth && (
        <>
          {published && canEdit && (
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <Eye className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              <p>חודש זה מוצג לדיירים — שינויים ייראו מיד.</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard title="הכנסות" value={ils(op.income)} subtitle="תקציב שוטף" tone="green" icon={TrendingUp} />
            <KpiCard title="הוצאות" value={ils(op.expense)} subtitle="תקציב שוטף" tone="red" icon={TrendingDown} />
            <KpiCard title="הפרש" value={ils(op.diff)} subtitle={op.diff < 0 ? 'גירעון בחודש' : 'עודף בחודש'} tone={op.diff < 0 ? 'amber' : 'cyan'} icon={Scale} />
          </div>

          <section className="space-y-3">
            <SectionTitle count={entries.filter((e) => e.kind === 'income').length}>הכנסות</SectionTitle>
            <EntryGroupTable
              kind="income"
              entries={entries.filter((e) => e.kind === 'income')}
              canEdit={canEdit}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
              emptyText={`אין הכנסות ב${periodLabel(period)}.`}
            />
          </section>

          <section className="space-y-3">
            <SectionTitle count={entries.filter((e) => e.kind === 'expense').length}>הוצאות</SectionTitle>
            <EntryGroupTable
              kind="expense"
              entries={entries.filter((e) => e.kind === 'expense')}
              canEdit={canEdit}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
              emptyText={`אין הוצאות ב${periodLabel(period)}.`}
            />
          </section>
        </>
      )}

      {!isFund && !isMonth && report && <PeriodReportView report={report} period={period} />}

      {isFund && fund && (
        <FundTab
          kpis={fund}
          canEdit={canEdit}
          // The ledger hands back its (resident-shaped) row; the full entry is looked up by id.
          onEdit={(row) => { const e = fund.entries.find((x) => x.id === row.id); if (e) openEdit(e); }}
          onDelete={(row) => { const e = fund.entries.find((x) => x.id === row.id); if (e) setDeleteTarget(e); }}
          onTargetSaved={refresh}
        />
      )}

      <EntrySheet
        key={sheetKey}
        open={sheet.open}
        kind={sheet.kind}
        section={section}
        entry={sheet.entry}
        defaultMonth={isMonth ? period.key : currentMonthKey()}
        categories={categories}
        suppliers={suppliers}
        canEdit={canEdit}
        onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
        onSaved={refresh}
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
