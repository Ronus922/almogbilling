import { CheckCircle2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Section } from './Section';
import type { CompletedAction } from '@/types/tenant';

interface Props {
  actions: CompletedAction[];
}

function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  const ymd = String(iso).slice(0, 10);
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function isSameDay(a: string, b: string): boolean {
  return String(a).slice(0, 10) === String(b).slice(0, 10);
}

export function CompletedActionsCard({ actions }: Props) {
  return (
    <Section title="היסטוריית פעולות שבוצעו" icon={CheckCircle2} iconTone="emerald">
      {actions.length === 0 ? (
        <p className="text-xs text-slate-400 py-2 text-center">אין פעולות שבוצעו עדיין.</p>
      ) : (
        <ul className="space-y-2 pb-1">
          {actions.map((a) => {
            const dueLabel = formatDueDate(a.due_date);
            const showDueNote = dueLabel && a.due_date && !isSameDay(a.due_date, a.completed_at);
            const relative = formatDistanceToNow(new Date(a.completed_at), { addSuffix: true, locale: he });
            return (
              <li key={a.id} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">
                    {a.description}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    בוצע ע״י <span className="font-semibold text-slate-700">{a.completed_by_name}</span>
                    <span className="mx-1.5 text-slate-400">•</span>
                    {relative}
                    {showDueNote && (
                      <>
                        <span className="mx-1.5 text-slate-400">•</span>
                        תאריך יעד היה: <span dir="ltr" className="tabular-nums">{dueLabel}</span>
                      </>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
