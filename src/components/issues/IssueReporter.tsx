'use client';

import { useState } from 'react';
import { Check, Copy, Megaphone } from 'lucide-react';
import { Section } from '@/components/side-panel/Section';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPhoneDisplay } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { PORTAL_ROLE_LABEL } from '@/lib/portal/identity';
import type { Issue } from '@/lib/types/issues';

// An issue opened by an owner from the portal (/portal/report, source='portal'):
// the violet "דיווח דייר · name · apartment" marking (ResidentReportStrip +
// RESIDENT_REPORT_ACCENT) on the kanban card, the table row and the top of the
// issue panel; the read-only "נפתח ע״י" block in the panel; and on the worker
// screens the smaller "פורטל דיירים" tag + "name · apartment". The rest of the
// issue is edited in the existing panel exactly like any other issue.
//
// The reporter's PHONE is never part of the issue row (ISSUE_COLUMNS leaves it
// out): the panel gets it from GET /api/issues/[id] only for contacts:view.
// `canSeePhone` is the UI gate of the same predicate (canSeeReporterPhone).

type ReporterFields = Pick<Issue, 'source' | 'reporter_name' | 'reporter_apartment'>
  & Partial<Pick<Issue, 'reporter_role'>>;

/** "פורטל דיירים" — DESIGN §10 soft pill, violet tone (unused by the issue
 *  statuses / priorities, so the source never reads as one of them). */
export function PortalSourceTag({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-violet-100 font-medium text-violet-600',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs',
      )}
    >
      פורטל דיירים
    </span>
  );
}

/** "ישראל ישראלי · דירה 520 · שוכר" — null for a staff issue. The role is
 *  the one held in that apartment when reporting (03/10/2026). */
export function reporterLabel(issue: ReporterFields): string | null {
  if (issue.source !== 'portal') return null;
  const parts = [
    issue.reporter_name?.trim() || null,
    // NULL = an unidentified reporter (a blocked phone): no apartment, no role.
    issue.reporter_apartment?.trim() ? `דירה ${issue.reporter_apartment.trim()}` : null,
    issue.reporter_role ? PORTAL_ROLE_LABEL[issue.reporter_role] : null,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}

/** "דיווח דייר · ישראל ישראלי · דירה 520 · בעלים"; an unidentified reporter reads
 *  "דיווח דייר · לא מזוהה" (their name IS "לא מזוהה" and they have no apartment).
 *  null for a staff issue. */
export function residentReportLabel(issue: ReporterFields): string | null {
  if (issue.source !== 'portal') return null;
  const who = reporterLabel(issue);
  return who ? `דיווח דייר · ${who}` : 'דיווח דייר';
}

/** The resident-report edge: border-inline-start in the same violet as the
 *  strip, on the kanban card, the table row's first cell and the mobile card. */
export const RESIDENT_REPORT_ACCENT = 'border-s-[3px] border-s-violet-500';

/**
 * The resident-report marking — DESIGN §2 violet tone (`bg-violet-50` /
 * `text-violet-700`, the same family as the "מדיירים" filter), Megaphone icon.
 *   card  — full-width strip across the top of a kanban card;
 *   row   — compact line under the title in the table / mobile list;
 *   panel — the banner at the top of the issue panel.
 */
export function ResidentReportStrip({ issue, variant }: {
  issue: ReporterFields;
  variant: 'card' | 'row' | 'panel';
}) {
  const label = residentReportLabel(issue);
  if (!label) return null;
  if (variant === 'card') {
    return (
      <div className="flex min-w-0 items-center gap-1.5 border-b border-violet-200 bg-violet-50 px-3.5 py-1.5 text-[12px] font-semibold text-violet-700">
        <Megaphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </div>
    );
  }
  if (variant === 'row') {
    return (
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-violet-50 px-2 py-0.5 text-[12px] font-semibold text-violet-700">
        <Megaphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </span>
    );
  }
  return (
    <div className={cn('flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-bold text-violet-700', RESIDENT_REPORT_ACCENT)}>
      <Megaphone className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </div>
  );
}

/** "חדר מדרגות · בין קומה 2 ל-3" — where the resident said the fault is, as
 *  typed; null for a staff issue (its place is the target, if any). */
export function reporterWhere(issue: Pick<Issue, 'source' | 'reporter_location' | 'reporter_area'>): string | null {
  if (issue.source !== 'portal' || !issue.reporter_location) return null;
  const area = issue.reporter_area?.trim();
  return area ? `${issue.reporter_location} · ${area}` : issue.reporter_location;
}

/** The tag + who reported, for a list row / kanban card. Nothing for staff issues. */
export function IssueSourceLine({ issue, size = 'md' }: { issue: ReporterFields; size?: 'sm' | 'md' }) {
  if (issue.source !== 'portal') return null;
  const label = reporterLabel(issue);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <PortalSourceTag size={size} />
      {label && (
        <span className={cn('min-w-0 truncate text-slate-500', size === 'sm' ? 'text-[11px]' : 'text-[12.5px]')}>{label}</span>
      )}
    </span>
  );
}

/** '+972523326988' → '052-332-6988'; a foreign number stays E.164. */
function phoneDisplay(e164: string): string {
  return e164.startsWith('+972') ? (formatPhoneDisplay(e164) ?? e164) : e164;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-base font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-semibold text-slate-900 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function CopyPhone({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      window.setTimeout(() => setDone(false), 1500);
    } catch {
      // No clipboard permission — the number is on screen and selectable.
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="העתקת מספר הטלפון"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[11px] border border-line bg-white text-ink-2 transition-colors hover:bg-row-hover hover:text-ink"
          />
        }
      >
        {done ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
      </TooltipTrigger>
      <TooltipContent>{done ? 'הועתק' : 'העתקה'}</TooltipContent>
    </Tooltip>
  );
}

/**
 * "נפתח ע״י" — read-only, portal issues only: who reported (the snapshot taken
 * at report time), how to reach them, and the location as they wrote it. The
 * phone row exists only for an actor with contacts:view AND a phone the API
 * actually sent; otherwise name + apartment only. The violet tag that sat in
 * its header gave way to the ResidentReportStrip above the block.
 */
export function IssueReporterSection({ issue, phone, canSeePhone }: {
  issue: Pick<Issue, 'source' | 'reporter_name' | 'reporter_apartment' | 'reporter_location' | 'reporter_area' | 'ticket_number'>;
  phone: string | null;
  canSeePhone: boolean;
}) {
  if (issue.source !== 'portal') return null;
  const showPhone = canSeePhone && !!phone;
  // An unidentified reporter (no roster link, no apartment): for an actor who
  // may see phones the name row says WHICH phone — "לא מזוהה — טלפון 052-…".
  // Everyone else sees "לא מזוהה" only (the phone is contacts:view).
  const unidentified = !issue.reporter_apartment?.trim();
  const name = issue.reporter_name?.trim() || '—';
  return (
    <Section title="נפתח ע״י" icon={Megaphone} iconTone="violet">
      <dl className="space-y-2.5 py-2 text-sm">
        <Row label="שם">
          {unidentified && showPhone && phone ? (
            <>{name} — טלפון <span dir="ltr" className="font-num">{phoneDisplay(phone)}</span></>
          ) : name}
        </Row>
        <Row label="דירה"><span className="font-num">{issue.reporter_apartment?.trim() || '—'}</span></Row>
        {showPhone && (
          <Row label="טלפון">
            <span className="inline-flex items-center gap-2">
              <a
                href={`tel:${phone}`}
                dir="ltr"
                className="inline-flex min-h-11 items-center font-num font-semibold text-brand underline-offset-2 hover:underline"
              >
                {phoneDisplay(phone)}
              </a>
              <CopyPhone value={phoneDisplay(phone)} />
            </span>
          </Row>
        )}
        <Row label="מיקום">{issue.reporter_location ?? '—'}</Row>
        <Row label="קומה / אזור">{issue.reporter_area?.trim() || '—'}</Row>
        {issue.ticket_number !== null && (
          <Row label="מספר קריאה"><span className="font-num" dir="ltr">#{issue.ticket_number}</span></Row>
        )}
      </dl>
    </Section>
  );
}
