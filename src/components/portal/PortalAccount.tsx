import type { PortalAccount } from '@/lib/types/portal';
import { PORTAL_BLOCKS } from '@/lib/portal/blocks';
import { fmtDateDMY, fmtIls } from '@/lib/portal/ui';
import { PortalSoon } from './PortalSoon';
import { AccountIcon } from './PortalIcons';

// "החשבון שלי" (#t-acc of the reference, without the pay button): four KPIs
// in c3 — balance due, management-fee debt, hot-water debt, monthly charge —
// then the CRM's free-text details, and the reference's personal ledger,
// built but off (PORTAL_BLOCKS.ledger). One block per apartment of the
// signed-in owner; the figures come from getPortalMyAccount, which reads
// nothing but the session. An archived record shows a note instead of
// numbers (decision 28/09/2026). `details` is rendered as text (pre-line) —
// never as HTML.

const FOOTNOTE = 'הנתונים מתעדכנים פעם ביום ממערכת הגבייה. תשלום שבוצע היום יופיע בעדכון הבא.';

function subtitleOf(a: PortalAccount): string {
  const parts = [`דירה ${a.apartment_number}`];
  if (a.owner_display_name) parts.push(a.owner_display_name);
  const asOf = fmtDateDMY(a.synced_at);
  if (asOf) parts.push(`נכון ל-${asOf}`);
  return parts.join(' · ');
}

function AccountBlock({ account: a, heading }: { account: PortalAccount; heading: boolean }) {
  if (a.archived) {
    return (
      <div className="acc-block">
        {heading && <h2>דירה {a.apartment_number}</h2>}
        <div className="card">
          <h3>הנתונים בבדיקה מול חברת הניהול</h3>
          <p className="details">הרשומה של הדירה אינה פעילה במערכת הגבייה, ולכן לא מוצגים כאן סכומים. לפרטים פנו לחברת הניהול.</p>
        </div>
      </div>
    );
  }
  const due = a.total_debt ?? 0;
  return (
    <div className="acc-block">
      {heading && <h2>דירה {a.apartment_number}</h2>}
      <div className="pgrid">
        <div className="card kpi c3">
          <div className="k">יתרה לתשלום</div>
          <div className={`v num${due > 0 ? ' red' : ''}`}>{fmtIls(due)}</div>
        </div>
        <div className="card kpi c3">
          <div className="k">חוב דמי ניהול</div>
          <div className="v num">{fmtIls(a.management_fees ?? 0)}</div>
        </div>
        <div className="card kpi c3">
          <div className="k">חוב מים חמים</div>
          <div className="v num">{fmtIls(a.hot_water_debt ?? 0)}</div>
        </div>
        <div className="card kpi c3">
          <div className="k">חיוב חודשי</div>
          <div className="v txt">{a.monthly_debt ?? '—'}</div>
        </div>
        {a.details && (
          <div className="card c12">
            <h3>פירוט</h3>
            <p className="details">{a.details}</p>
          </div>
        )}
        {PORTAL_BLOCKS.ledger && (
          <div className="card c12">
            <h3>כרטסת אישית</h3>
            <div className="tw">
              <table>
                <thead><tr><th>חודש</th><th>חיוב</th><th>תשלום</th><th>סטטוס</th><th>קבלה</th></tr></thead>
                <tbody />
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PortalAccountView({ accounts }: { accounts: readonly PortalAccount[] }) {
  if (accounts.length === 0) {
    return <PortalSoon icon={<AccountIcon />} title="החשבון שלי" text="לא נמצאה דירה פעילה עבור המספר הזה. פנו לחברת הניהול." />;
  }
  const single = accounts.length === 1;
  const first = accounts[0];
  const asOf = fmtDateDMY(first.synced_at);
  return (
    <section id="t-acc">
      <div className="hd">
        <div>
          <h1>החשבון שלי</h1>
          <p>{single ? subtitleOf(first) : `${accounts.length} דירות${first.owner_display_name ? ` · ${first.owner_display_name}` : ''}${asOf ? ` · נכון ל-${asOf}` : ''}`}</p>
        </div>
      </div>
      {accounts.map((a) => <AccountBlock key={a.apartment_number} account={a} heading={!single} />)}
      <p className="foot">{FOOTNOTE}</p>
    </section>
  );
}
