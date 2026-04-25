import { FileText } from 'lucide-react';
import { Section } from './Section';
import type { Tenant } from '@/types/tenant';

interface Props {
  tenant: Tenant;
}

export function AdditionalInfoCard({ tenant }: Props) {
  return (
    <Section title="מידע נוסף" icon={FileText} iconTone="slate">
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-lg font-extrabold text-muted-foreground mb-1">פרטים</dt>
          <dd className="text-slate-900 whitespace-pre-wrap break-words">
            {tenant.details ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-lg font-extrabold text-muted-foreground mb-1">חודשי פיגור</dt>
          <dd className="text-rose-600 font-medium whitespace-pre-wrap break-words">
            {tenant.monthly_debt ?? '—'}
          </dd>
        </div>
      </dl>
    </Section>
  );
}
