'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  decisionTypeTag, decisionYear, formatDecisionDate, formatFileSize, matchesDecisionQuery,
  type DecisionTypeFilter,
} from '@/lib/decisions';
import type { DecisionPortalView } from '@/lib/decisionsView';
import { ChevronIcon, ExportIcon, PdfIcon, SearchIcon } from './PortalIcons';
import { usePortalHref } from './usePortalHref';

// The "החלטות" tab (ref/portal/decisions-tab.md + the reference's `dec` tab) —
// and, since 14/10/2026, the "מאזנים" tab too: the SAME mechanism, a prop
// away. ONE flat list, newest first, cut by year separators, over a toolbar
// card.
//
// DECLARED EXCEPTION (the task's, 05/10/2026): the reference's category chips
// — הכל / אסיפות דיירים / תקציב וכספים / תחזוקה ושיפוצים / פרוטוקולים — are
// not built. The toolbar is the SEARCH FIELD ALONE, and the row's meta line
// therefore carries no topic tag either (there is no topic column at all, see
// the migration). Everything else is the reference, px for px.
//
// Read-only by construction: the rows arrive already filtered to `published`
// by the server, the summary is the only text, and the two buttons are the
// only exits — the open link and the same link with `?download=1`, both
// server-streamed from a private bucket. A resident never uploads here.
//
// The search is live and local: the whole published list is already on the
// client (a building's decisions are tens of rows, not thousands), so typing
// filters without a round trip, exactly as the reference does.
//
// `kind` picks only the copy and the lock message — never the mechanism: the
// decisions tab mixes doc_type 'decision'/'protocol' (DESIGN.md's unified
// list, kept on purpose — 14/10/2026 did not split it), the balances tab
// carries 'balance' rows alone, and the server (portalDecisions.ts) decides
// which rows reach which tab, never this component.
type DecisionsKind = 'decisions' | 'balances';

const COPY: Record<DecisionsKind, {
  heading: string;
  subtitle: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyText: string;
  /** The permission name as it reads in the lock message — matches the
   *  module's current label (lib/permissions/constants.ts) exactly. */
  lockPermissionLabel: string;
}> = {
  decisions: {
    heading: 'החלטות ופרוטוקולים',
    subtitle: 'החלטות ועד הבית ופרוטוקולי אסיפות דיירים, להורדה כ-PDF',
    searchPlaceholder: 'חיפוש החלטה או פרוטוקול…',
    emptyTitle: 'עדיין לא פורסמו החלטות או פרוטוקולים',
    emptyText: 'ברגע שוועד הבית יפרסם החלטה או פרוטוקול, הם יופיעו כאן להורדה.',
    lockPermissionLabel: 'החלטות ופרוטוקולים',
  },
  balances: {
    heading: 'מאזנים',
    subtitle: 'מאזנים ודוחות כספיים שפורסמו, להורדה כ-PDF',
    searchPlaceholder: 'חיפוש מאזן…',
    emptyTitle: 'עדיין לא פורסמו מאזנים',
    emptyText: 'ברגע שחברת הניהול תפרסם מאזן, הוא יופיע כאן להורדה.',
    lockPermissionLabel: 'החלטות, פרוטוקולים ומאזנים',
  },
};

const TYPE_CHIPS: ReadonlyArray<{ key: DecisionTypeFilter; label: string }> = [
  { key: 'all', label: 'הכל' },
  { key: 'decision', label: 'החלטות' },
  { key: 'protocol', label: 'פרוטוקולים' },
];

export function PortalDecisions({ decisions, staffFileUrls, kind = 'decisions', initialType = 'all' }: {
  decisions: DecisionPortalView[];
  /** The admin preview only (/finance?view=resident): decision id → its staff
   *  path (/api/files/portal-decisions/…). Staff have no portal session, so the
   *  owners' route would answer them 404. Absent in the portal itself; EMPTY
   *  for a viewer without portal_decisions:view, whose rows then carry a note
   *  instead of two buttons that would answer 403. */
  staffFileUrls?: Record<string, string>;
  /** 'decisions' (default) — the "החלטות" tab. 'balances' — the "מאזנים" tab
   *  added 14/10/2026, replacing the removed "דוחות" tab in the nav. */
  kind?: DecisionsKind;
  /** The "dec" tab's type chips (round 2, 14/10/2026), parsed server-side from
   *  `?type=` so the first paint already matches the URL. Ignored for
   *  'balances' — that tab carries one doc_type, no chips. */
  initialType?: DecisionTypeFilter;
}) {
  const copy = COPY[kind];
  const href = usePortalHref();
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [type, setType] = useState<DecisionTypeFilter>(initialType);

  // A URL-reflected filter with no round trip — the whole list is already on
  // the client, so a chip just re-renders locally; the history write (not
  // router.push) is the same trick PortalTransactions' changeFilter uses for
  // `?f=` on the tx tab, so a shared/reopened link lands on the same chip.
  function changeType(next: DecisionTypeFilter) {
    setType(next);
    window.history.replaceState(window.history.state, '', href({ tab: 'dec', type: next === 'all' ? null : next }));
  }

  // The visible rows, each already told whether it OPENS a year — worked out
  // here rather than during render, so the list stays a pure function of
  // (decisions, query, type) and no counter survives between renders.
  const visible = useMemo(() => {
    const byType = kind === 'decisions' && type !== 'all' ? decisions.filter((d) => d.doc_type === type) : decisions;
    const matching = byType.filter((d) => matchesDecisionQuery(d, query));
    // A row opens a year when the row before it (in the SAME filtered list)
    // belongs to another one — so a search that hides every 2025 row hides the
    // "2025" separator with it.
    return matching.map((d, i) => {
      const year = decisionYear(d.decided_at);
      return { d, year, opensYear: i === 0 || decisionYear(matching[i - 1].decided_at) !== year };
    });
  }, [decisions, query, type, kind]);

  // Nothing has ever been published — not an empty search result but an empty
  // tab, and it says so instead of offering a search over nothing.
  if (decisions.length === 0) {
    return (
      <section>
        <div className="hd">
          <div>
            <h1>{copy.heading}</h1>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        <div className="card empty">
          <div className="ic"><PdfIcon size={28} /></div>
          <h2>{copy.emptyTitle}</h2>
          <p>{copy.emptyText}</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="hd">
        <div>
          <h1>{copy.heading}</h1>
          <p>{copy.subtitle}</p>
        </div>
      </div>
      <div className="card">
        <div className="dec-tools">
          {kind === 'decisions' && (
            <div className="chips" role="group" aria-label="סינון">
              {TYPE_CHIPS.map((c) => (
                <button key={c.key} type="button" className={`chipf${type === c.key ? ' on' : ''}`} aria-pressed={type === c.key} onClick={() => changeType(c.key)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <div className="srch">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={copy.searchPlaceholder}
              aria-label={copy.searchPlaceholder}
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty" style={{ padding: '48px 16px' }}>
            <h2 style={{ fontSize: 18 }}>לא נמצאו תוצאות</h2>
            <p style={{ fontSize: 14 }}>נסו מילת חיפוש אחרת או נקו את החיפוש.</p>
          </div>
        ) : (
          <div className="drows">
            {visible.map(({ d, year, opensYear }) => {
              const open = openId === d.id;
              const tagClass = d.doc_type === 'decision' ? 'tag' : d.doc_type === 'protocol' ? 'tag t-green' : 'tag t-amber';
              const fileHref: string | undefined = staffFileUrls
                ? staffFileUrls[d.id]
                : `/api/portal/decisions/${d.id}/file`;
              return (
                <Fragment key={d.id}>
                  {opensYear && <div className="yr num">{year}</div>}
                  <div className={open ? 'drow open' : 'drow'} data-decision={d.id}>
                    <button
                      type="button"
                      className="dmain"
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : d.id)}
                    >
                      <span className="dic"><PdfIcon /></span>
                      <div className="dtx">
                        <b>{d.title}</b>
                        <div className="dmeta">
                          <span
                            className={tagClass}
                            style={d.doc_type === 'decision' ? { background: 'var(--brand-soft)', color: 'var(--brand-ink)' } : undefined}
                          >
                            {decisionTypeTag(d.doc_type, d.decision_number)}
                          </span>
                          <span className="num">{formatDecisionDate(d.decided_at)}</span>
                          <span className="fsz">·</span>
                          <span className="fsz">PDF · <span className="num">{formatFileSize(d.file_size)}</span></span>
                        </div>
                      </div>
                      <ChevronIcon size={18} strokeWidth={2} className="chev" />
                    </button>
                    <div className="dbody">
                      {/* No summary → the buttons alone; an empty paragraph
                          would leave the reference's 14.5px line of air. */}
                      {d.summary && <p>{d.summary}</p>}
                      {fileHref ? (
                        <div className="dact">
                          <a
                            className="pbtn pbtn-primary pbtn-sm"
                            href={fileHref}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <PdfIcon size={16} strokeWidth={2} />פתיחת המסמך
                          </a>
                          <a
                            className="pbtn pbtn-secondary pbtn-sm"
                            href={`${fileHref}?download=1`}
                          >
                            <ExportIcon size={16} />הורדה
                          </a>
                        </div>
                      ) : (
                        <div className="dlock">תצוגה בלבד — פתיחת המסמך והורדתו דורשות הרשאת „{copy.lockPermissionLabel}”.</div>
                      )}
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
