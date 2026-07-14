import { redirect } from 'next/navigation';
import { LayoutDashboard, Banknote, Coins, Percent } from 'lucide-react';
import { getCurrentActor } from '@/lib/auth/actor';
import { homePathFor } from '@/lib/auth/home';
import { hasPermission } from '@/lib/permissions/check';
import { getCollectionVsDebt } from '@/lib/db/debtors';
import { getChatUnreadSummary } from '@/lib/db/internalChat';
import { KpiCard } from '@/components/KpiCard';
import {
  PERIODS,
  currentYm,
  monthsForPeriod,
  safe,
  loadCalendarMonth,
  loadTasks,
  loadIssues,
  loadReminders,
  loadWhatsapp,
  type Period,
} from './data';
import { ils, pct, MONTHS_HE } from './format';
import { OverviewControls } from './components/OverviewControls';
import { CollectionChart, type ChartPoint } from './components/CollectionChart';
import { CalendarWidget } from './components/CalendarWidget';
import { TasksWidget } from './components/TasksWidget';
import { IssuesWidget } from './components/IssuesWidget';
import { RemindersWidget } from './components/RemindersWidget';
import { ChatWidget } from './components/ChatWidget';
import { WhatsappWidget } from './components/WhatsappWidget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ period?: string; cal?: string }>;

export default async function OverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  // The overview is only for roles that actually land on it. A viewer holds just
  // dashboard:view, a field worker just tasks+issues — both would get an overview
  // with every widget permission-gated away, i.e. an empty page. Send them to
  // whatever homePathFor() says is their home instead of hardcoding the list
  // again. (Route-level only — no per-widget gating here.)
  const home = homePathFor(actor.role);
  if (home !== '/overview') redirect(home);

  const sp = await searchParams;
  const period: Period = (PERIODS as readonly string[]).includes(sp.period ?? '')
    ? (sp.period as Period)
    : 'month';
  const cal = /^\d{4}-\d{2}$/.test(sp.cal ?? '') ? (sp.cal as string) : currentYm();

  const can = (m: string) => hasPermission(actor.role, actor.permissions, m, 'view');
  const canReminders = can('user_reminders');

  // Each widget loads independently; a failure (or a query its own guard would
  // reject) resolves to null and the widget renders its own empty state — one
  // widget never blanks the page.
  const [collection, calendar, tasks, issues, reminders, chat, whatsapp] = await Promise.all([
    can('dashboard') ? safe(() => getCollectionVsDebt(monthsForPeriod(period))) : Promise.resolve(null),
    can('calendar') ? safe(() => loadCalendarMonth(cal, actor.id, canReminders)) : Promise.resolve(null),
    can('tasks') ? safe(() => loadTasks()) : Promise.resolve(null),
    can('issues') ? safe(() => loadIssues()) : Promise.resolve(null),
    canReminders ? safe(() => loadReminders(actor.id)) : Promise.resolve(null),
    can('internal_chat') ? safe(() => getChatUnreadSummary(actor.id, 5)) : Promise.resolve(null),
    can('whatsapp_chat') ? safe(() => loadWhatsapp()) : Promise.resolve(null),
  ]);

  const dateLabel = new Date().toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const cy = currentYm();
  const chartData: ChartPoint[] =
    collection?.series.map((p) => ({
      ym: p.ym,
      label: MONTHS_HE[p.month - 1],
      collection: p.collection,
      debt: p.totalDebt,
      isCurrent: p.ym === cy,
      // Collection rate per month = collection / opening (prev-month) debt. The
      // baseline month has no opening balance to divide by → "—", not 0%.
      rateLabel: p.isBaseline ? '—' : `${Math.round(p.collectionRate * 100)}%`,
    })) ?? [];

  const k = collection?.kpis;
  const deltaPct = k ? Math.round(k.avgCollectionRateDelta * 100) : 0;
  const deltaLabel = !k || deltaPct === 0 ? undefined : `${deltaPct > 0 ? '▲' : '▼'} ${Math.abs(deltaPct)}%`;

  const last = collection?.series.at(-1);
  const first = collection?.series.at(0);
  // Name the month the value is actually for (matches the mockup's "נגבה ביוני")
  // so the figure never disagrees with a generic "this month" label when the
  // latest snapshot predates the current calendar month.
  const collectedLabel = last ? `נגבה ב${MONTHS_HE[last.month - 1]}` : 'נגבה החודש';
  const chartSubtitle = first && last
    ? `${MONTHS_HE[first.month - 1]}–${MONTHS_HE[last.month - 1]} ${last.year} · בש״ח`
    : 'בש״ח';

  return (
    <div className="space-y-4">
      {/* ── page header + period/refresh controls ── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[14px] bg-brand text-white shadow-soft-md" aria-hidden>
            <LayoutDashboard className="h-[23px] w-[23px]" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">לוח מחוונים</h1>
            <p className="mt-0.5 text-[13.5px] font-medium text-ink-3">סקירה כללית של הפעילות · {dateLabel}</p>
          </div>
        </div>
        <OverviewControls period={period} />
      </div>

      {/* ── hero KPIs ── */}
      {k && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard tone="cyan" icon={Banknote} title={collectedLabel} value={ils(k.collectedThisMonth)} />
          <KpiCard tone="amber" icon={Coins} title="יתרת חוב פתוחה" value={ils(k.openDebtBalance)} />
          <KpiCard tone="green" icon={Percent} title="שיעור גבייה ממוצע" value={pct(k.avgCollectionRate)} subtitle={deltaLabel} />
        </div>
      )}

      {/* ── hero chart: collection vs debt ── */}
      {collection ? (
        <div className="rounded-2xl border border-line bg-white p-5 shadow-soft-xs">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-ink">גבייה מול חובות לפי חודש</h2>
              <p className="mt-0.5 text-[12.5px] font-medium text-ink-3">{chartSubtitle}</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">
                <span className="h-3 w-3 rounded-[4px]" style={{ background: '#3d5afe' }} />
                נגבה בפועל
              </span>
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">
                <span className="h-3 w-3 rounded-[4px]" style={{ background: '#f59e0b' }} />
                יתרת חוב
              </span>
            </div>
          </div>
          <CollectionChart data={chartData} />
        </div>
      ) : (
        <div className="rounded-2xl border border-line bg-white p-10 text-center text-sm text-ink-3 shadow-soft-xs">
          לא ניתן לטעון את נתוני הגבייה
        </div>
      )}

      {/* ── row 1: calendar · tasks · issues ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {can('calendar') && <CalendarWidget data={calendar} period={period} />}
        {can('tasks') && <TasksWidget data={tasks} />}
        {can('issues') && <IssuesWidget data={issues} />}
      </div>

      {/* ── row 2: reminders · internal chat · whatsapp ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {canReminders && <RemindersWidget data={reminders} />}
        {can('internal_chat') && <ChatWidget data={chat} />}
        {can('whatsapp_chat') && <WhatsappWidget data={whatsapp} />}
      </div>
    </div>
  );
}
