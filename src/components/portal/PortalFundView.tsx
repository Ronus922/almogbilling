'use client';

import type { ResidentFundKpis } from '@/lib/types/finance';
import { FundTab } from '@/components/finance/FundTab';

// The renovation-fund tab: the existing FundTab (resident mode) as it is —
// content, KPIs and logic untouched (decision 28/09/2026); only the tab button
// in the top bar took the reference's `.nav` style. The `.fund-host` box keeps
// it on the portal's Heebo; the portal skin's table rules are scoped to `.tw`,
// so the fund ledger renders exactly as on /finance?view=resident.
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
          ? <FundTab kpis={fund} canEdit={false} residentMode onEdit={() => undefined} onDelete={() => undefined} onTargetSaved={() => undefined} />
          : <div className="card empty"><h2>עוד לא פורסמו חודשים.</h2></div>}
      </div>
    </section>
  );
}
