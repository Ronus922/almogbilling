'use client';

import type { ResidentFundKpis } from '@/lib/types/finance';
import { FundTab } from '@/components/finance/FundTab';
import { fmtIls } from '@/lib/portal/ui';

// The renovation-fund tab: the existing FundTab (resident mode) — content,
// KPIs and logic untouched (decision 28/09/2026); only the tab button in the
// top bar took the reference's `.nav` style. Since the evening of 28/09/2026
// its amounts go through the portal's formatter (whole shekels, ₪ attached)
// and its incomes / expenses wear the portal's green-ink / red-ink — the
// admin's fund tab on /finance keeps its own format and colours. The
// `.fund-host` box keeps it on the portal's Heebo; the portal skin's table
// rules are scoped to `.tw`, so the fund ledger renders as its own tables.
export function PortalFundView({ fund }: { fund: ResidentFundKpis | null }) {
  return (
    <section id="t-fund">
      <div className="hd">
        <div>
          <h1>קרן שיפוצים</h1>
          <p>מצטבר מכל החודשים שפורסמו</p>
        </div>
      </div>
      <div className="fund-host">
        {fund
          ? <FundTab kpis={fund} canEdit={false} residentMode format={fmtIls} onEdit={() => undefined} onDelete={() => undefined} onTargetSaved={() => undefined} />
          : <div className="card empty"><h2>עוד לא פורסמו חודשים.</h2></div>}
      </div>
    </section>
  );
}
