import { FileText } from 'lucide-react';
import { Section } from './Section';
import { visibleImportText } from '@/lib/debtor-import-text';
import type { Tenant } from '@/types/tenant';

interface Props {
  tenant: Tenant;
}

// "פרטים" and "חודשי פיגור" come from the import and describe the debt, so with
// a ₪0 balance they read "—" rather than a leftover from an earlier report —
// see lib/debtor-import-text.ts.
export function AdditionalInfoCard({ tenant }: Props) {
  const details = visibleImportText(tenant.details, tenant.total_debt);
  const monthlyDebt = visibleImportText(tenant.monthly_debt, tenant.total_debt);
  return (
    <Section title="מידע נוסף" icon={FileText} iconTone="slate">
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-lg font-extrabold text-muted-foreground mb-1">פרטים</dt>
          <dd className="text-slate-900 whitespace-pre-wrap break-words">
            {details ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-lg font-extrabold text-muted-foreground mb-1">חודשי פיגור</dt>
          <dd className="text-rose-600 font-medium whitespace-pre-wrap break-words">
            {monthlyDebt ?? '—'}
          </dd>
        </div>
      </dl>
    </Section>
  );
}
