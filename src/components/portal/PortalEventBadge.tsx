import { cn } from '@/lib/utils';
import { PORTAL_EVENT_LABEL, PORTAL_EVENT_TONE, type PortalEventType } from '@/lib/constants/portal';

// The "אירוע" pill of the login log. ONE component for both log surfaces (the
// apartment card's tab and /admin/portal-log) so a label or a tone can never
// differ between them — the vocabulary itself lives in constants/portal.ts.
// Tones follow the DESIGN.md §10 families (bg-{tone}-50 / text-{tone}-700).

const TONE_CLASS: Record<(typeof PORTAL_EVENT_TONE)[PortalEventType], string> = {
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rose:    'bg-rose-50 text-rose-700 ring-rose-200',
  amber:   'bg-amber-50 text-amber-700 ring-amber-200',
  blue:    'bg-blue-50 text-blue-700 ring-blue-200',
  slate:   'bg-slate-100 text-slate-600 ring-slate-200',
};

export function PortalEventBadge({ eventType }: { eventType: PortalEventType }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1',
        TONE_CLASS[PORTAL_EVENT_TONE[eventType]],
      )}
    >
      {PORTAL_EVENT_LABEL[eventType]}
    </span>
  );
}
