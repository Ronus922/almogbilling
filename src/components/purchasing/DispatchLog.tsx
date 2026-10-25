'use client';

// The "יומן שליחות" tab: one row per dispatch — supplier, channel, outcome, when.

import { History } from 'lucide-react';
import { Section } from '@/components/side-panel/Section';
import { formatStampIL } from '@/lib/purchasing/model';
import type { DocumentDetail } from './types';

export function DispatchLog({ dispatches }: { dispatches: DocumentDetail['dispatches'] }) {
  if (dispatches.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-white p-4 text-center text-sm text-ink-3" data-dispatches-empty>
        המסמך טרם נשלח.
      </p>
    );
  }
  return (
    <Section title="יומן שליחות" icon={History} iconTone="blue">
      <ul className="space-y-2 py-2" data-dispatches>
        {dispatches.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-white px-4 py-3 text-sm">
            <span className="font-bold text-ink">{d.supplier_name}</span>
            <span className="text-ink-3">{d.channel === 'email' ? 'מייל' : 'WhatsApp'}</span>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${d.status === 'sent' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
              {d.status === 'sent' ? 'נשלח' : 'נכשל'}
            </span>
            <span className="ms-auto tabular-nums text-ink-3">{formatStampIL(d.sent_at)}</span>
            {d.error && <span className="w-full text-xs text-rose-600">{d.error}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
