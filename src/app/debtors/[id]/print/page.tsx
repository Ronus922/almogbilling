import { redirect, notFound } from 'next/navigation';
import {
  Home, FileText, Wallet, Calendar, Scale, CheckCircle2, MessageSquare, Clock,
} from 'lucide-react';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { getDebtorById } from '@/lib/db/debtors';
import { listCommentsByDebtor } from '@/lib/db/comments';
import { listCompletedActionsByDebtor } from '@/lib/db/completedActions';
import { listDebtorHistory } from '@/lib/db/debtorHistory';
import { formatPhoneDisplay } from '@/lib/phone';
import type { Tenant } from '@/types/tenant';
import { AutoPrint } from './AutoPrint';

export const runtime = 'nodejs';
// Always render fresh — the print/PDF must reflect the debtor's current state.
export const dynamic = 'force-dynamic';

const ils = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
});

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const ymd = String(iso).slice(0, 10);
  const [y, m, d] = ymd.split('-');
  return d && m && y ? `${d}/${m}/${y}` : '—';
}

// Print-specific rules kept in a scoped <style> (globals.css stays an index of
// @imports per the project's iron rule). Exact color so status/KPI tints print.
const PRINT_CSS = `
@page { size: A4 portrait; margin: 14mm; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print {
  html, body { background: #fff !important; }
  /* The app-wide debtors-table print CSS (styles/print.css) hides every body
     child except its own portal (#debtors-print-root) and forces landscape.
     This standalone route is a second print context — force OUR root visible
     (selector specificity 0,1,2 + !important beats the 0,1,1 hide rule). */
  body > div#debtor-detail-print { display: block !important; }
  .no-print { display: none !important; }
  .avoid-break { break-inside: avoid; }
  .page-break { break-before: page; }
}
`;

export default async function DebtorPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoprint?: string }>;
}) {
  const { id } = await params;
  const { autoprint } = await searchParams;

  // RBAC — same as the debtor panel: viewer (dashboard:view) OR manager (contacts:view).
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  const canView =
    hasPermission(actor.role, actor.permissions, 'dashboard', 'view') ||
    hasPermission(actor.role, actor.permissions, 'contacts', 'view');
  if (!canView) redirect('/');

  const tenant = await getDebtorById(id);
  if (!tenant) notFound();

  const [notes, actions, history] = await Promise.all([
    listCommentsByDebtor(id),
    listCompletedActionsByDebtor(id),
    listDebtorHistory(id),
  ]);

  const generatedAt = fmtDateTime(new Date().toISOString());

  return (
    <div
      id="debtor-detail-print"
      dir="rtl"
      className="mx-auto max-w-[820px] bg-white p-8 text-slate-900"
      style={{ fontFamily: 'var(--font-heebo)' }}
    >
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="avoid-break mb-6 border-b-2 border-slate-900 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">
              פרטי דירה {tenant.apartment_number}
            </h1>
            <p className="mt-1 text-sm text-slate-600">{tenant.owner_name ?? '—'}</p>
          </div>
          <div className="text-end">
            {tenant.legal_status_name && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-slate-900/10"
                style={{ backgroundColor: `${tenant.legal_status_color ?? '#f1f5f9'}22` }}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: tenant.legal_status_color ?? '#94a3b8' }}
                />
                {tenant.legal_status_name}
              </span>
            )}
            <p className="mt-2 text-xs text-slate-400">הופק: {generatedAt}</p>
          </div>
        </div>
      </header>

      {/* ── פרטים עיקריים ──────────────────────────────────────── */}
      <PrintSection title="פרטים עיקריים" icon={Home}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field label="מספר דירה" value={tenant.apartment_number} />
          <Field label="בעל הדירה" value={tenant.owner_name} />
          <Field label="טלפון בעלים" value={formatPhoneDisplay(tenant.phone_owner) || '—'} ltr />
          <Field label="טלפון שוכר" value={formatPhoneDisplay(tenant.phone_tenant) || '—'} ltr />
          <Field label='דוא"ל בעלים' value={tenant.email_owner} ltr />
          <Field label='דוא"ל שוכר' value={tenant.email_tenant} ltr />
        </dl>
      </PrintSection>

      {/* ── מידע נוסף ──────────────────────────────────────────── */}
      <PrintSection title="מידע נוסף" icon={FileText}>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="font-semibold text-slate-500">פרטים</dt>
            <dd className="whitespace-pre-wrap break-words">{tenant.details ?? '—'}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">חודשי פיגור</dt>
            <dd className="whitespace-pre-wrap break-words text-rose-700">{tenant.monthly_debt ?? '—'}</dd>
          </div>
        </dl>
      </PrintSection>

      {/* ── פירוט חובות ─────────────────────────────────────────── */}
      <PrintSection title="פירוט חובות ותשלומים" icon={Wallet}>
        <div className="grid grid-cols-3 gap-3">
          <Kpi label='סה"כ חוב' value={tenant.total_debt} tone="rose" />
          <Kpi label="דמי ניהול" value={tenant.management_fees} tone="blue" />
          <Kpi label="מים חמים" value={tenant.hot_water_debt} tone="violet" />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          עודכן לאחרונה: {fmtDateTime(tenant.last_imported_at)}
        </p>
      </PrintSection>

      {/* ── פעולה הבאה ─────────────────────────────────────────── */}
      <PrintSection title="פעולה הבאה לביצוע" icon={Calendar}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field label="תיאור פעולה" value={tenant.next_action_description} />
          <Field label="תאריך יעד" value={fmtDate(tenant.next_action_date)} ltr />
        </dl>
      </PrintSection>

      {/* ── ניהול משפטי ────────────────────────────────────────── */}
      <PrintSection title="ניהול משפטי" icon={Scale}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field label="סטטוס משפטי" value={tenant.legal_status_name ?? 'ללא סטטוס'} />
          <Field label="עודכן לאחרונה" value={fmtDateTime(tenant.legal_status_updated_at)} ltr />
          <Field label="עודכן על ידי" value={tenant.legal_status_updated_by_name} />
        </dl>
      </PrintSection>

      {/* ── פעולות שבוצעו ──────────────────────────────────────── */}
      <PrintSection title="היסטוריית פעולות שבוצעו" icon={CheckCircle2}>
        {actions.length === 0 ? (
          <p className="text-sm text-slate-400">אין פעולות שבוצעו.</p>
        ) : (
          <ul className="space-y-2">
            {actions.map((a) => (
              <li key={a.id} className="avoid-break rounded-lg border border-slate-200 p-3 text-sm">
                <p className="whitespace-pre-wrap break-words text-slate-800">{a.description}</p>
                <p className="mt-1 text-xs text-slate-500">
                  בוצע ע״י {a.completed_by_name} · {fmtDateTime(a.completed_at)}
                  {a.due_date ? <> · תאריך יעד: {fmtDate(a.due_date)}</> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </PrintSection>

      {/* ── הערות ותיעוד ───────────────────────────────────────── */}
      <PrintSection title="הערות ותיעוד" icon={MessageSquare}>
        {notes.length === 0 ? (
          <p className="text-sm text-slate-400">אין הערות.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="avoid-break rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold text-slate-900">{n.author_name}</span>
                  <span className="text-xs text-slate-400" dir="ltr">{fmtDateTime(n.created_at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-slate-700">{n.content}</p>
              </li>
            ))}
          </ul>
        )}
      </PrintSection>

      {/* ── היסטוריה מלאה (עמוד חדש) ───────────────────────────── */}
      <div className="page-break pt-6">
        <PrintSection title="היסטוריה מלאה" icon={Clock}>
          {history.length === 0 ? (
            <p className="text-sm text-slate-400">אין היסטוריה לדייר זה.</p>
          ) : (
            <ol className="space-y-2.5">
              {history.map((e) => (
                <li key={`${e.source}-${e.id}`} className="avoid-break rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-semibold text-slate-900">{e.title}</span>
                    <span className="text-xs text-slate-400" dir="ltr">{fmtDateTime(e.created_at)}</span>
                  </div>
                  {e.description && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-slate-700">{e.description}</p>
                  )}
                  {e.outcome && (
                    <p className="mt-1 text-xs font-medium text-emerald-700">תוצאה: {e.outcome}</p>
                  )}
                  {e.actor_name && <p className="mt-1 text-xs text-slate-500">{e.actor_name}</p>}
                </li>
              ))}
            </ol>
          )}
        </PrintSection>
      </div>

      <AutoPrint enabled={autoprint === '1'} />
    </div>
  );
}

// ── Presentational helpers ───────────────────────────────────────────────
function PrintSection({
  title, icon: Icon, children,
}: {
  title: string;
  icon: typeof Home;
  children: React.ReactNode;
}) {
  return (
    <section className="avoid-break mb-5">
      <h2 className="mb-2 flex items-center gap-2 text-base font-bold text-slate-900">
        <Icon className="h-4 w-4 text-slate-500" />
        {title}
      </h2>
      <div className="rounded-xl border border-slate-200 p-4">{children}</div>
    </section>
  );
}

function Field({ label, value, ltr }: { label: string; value: string | null; ltr?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="font-semibold text-slate-500">{label}</dt>
      <dd className="text-slate-900" dir={ltr ? 'ltr' : undefined}>{value || '—'}</dd>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: 'rose' | 'blue' | 'violet' }) {
  const fg = tone === 'rose' ? 'text-rose-700' : tone === 'blue' ? 'text-blue-700' : 'text-violet-700';
  const bg = tone === 'rose' ? 'bg-rose-50' : tone === 'blue' ? 'bg-blue-50' : 'bg-violet-50';
  return (
    <div className={`rounded-lg ${bg} p-3 text-center`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${fg}`}>{ils.format(value)}</div>
    </div>
  );
}

// ponytail: print history = the unified debtor timeline (comments/status/actions/
// events, incl. outbound WhatsApp events). Inbound WhatsApp replies live only in
// chat_messages and are not included — merge listChatMessagesByDebtor if needed.
