'use client';

import { useMemo, useState } from 'react';
import {
  decisionTypeTag, decisionYear, formatDecisionDate, formatFileSize, matchesDecisionQuery,
} from '@/lib/decisions';
import type { DecisionPortalView } from '@/lib/decisionsView';
import { ChevronIcon, ExportIcon, PdfIcon, SearchIcon } from './PortalIcons';

// The "החלטות" tab (ref/portal/decisions-tab.md + the reference's `dec` tab):
// ONE flat list, newest first, cut by year separators, over a toolbar card.
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

export function PortalDecisions({ decisions, staffFileUrls }: {
  decisions: DecisionPortalView[];
  /** The admin preview only (/finance?view=resident): decision id → its staff
   *  path (/api/files/portal-decisions/…). Staff have no portal session, so the
   *  owners' route would answer them 404. Absent in the portal itself; EMPTY
   *  for a viewer without portal_decisions:view, whose rows then carry a note
   *  instead of two buttons that would answer 403. */
  staffFileUrls?: Record<string, string>;
}) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  // The visible rows, each already told whether it OPENS a year — worked out
  // here rather than during render, so the list stays a pure function of
  // (decisions, query) and no counter survives between renders.
  const visible = useMemo(() => {
    const matching = decisions.filter((d) => matchesDecisionQuery(d, query));
    // A row opens a year when the row before it (in the SAME filtered list)
    // belongs to another one — so a search that hides every 2025 row hides the
    // "2025" separator with it.
    return matching.map((d, i) => {
      const year = decisionYear(d.decided_at);
      return { d, year, opensYear: i === 0 || decisionYear(matching[i - 1].decided_at) !== year };
    });
  }, [decisions, query]);

  // Nothing has ever been published — not an empty search result but an empty
  // tab, and it says so instead of offering a search over nothing.
  if (decisions.length === 0) {
    return (
      <section>
        <div className="hd">
          <div>
            <h1>החלטות ופרוטוקולים</h1>
            <p>החלטות ועד הבית ופרוטוקולי אסיפות דיירים, להורדה כ-PDF</p>
          </div>
        </div>
        <div className="card empty">
          <div className="ic"><PdfIcon size={28} /></div>
          <h2>עדיין לא פורסמו החלטות או פרוטוקולים</h2>
          <p>ברגע שוועד הבית יפרסם החלטה או פרוטוקול, הם יופיעו כאן להורדה.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="hd">
        <div>
          <h1>החלטות ופרוטוקולים</h1>
          <p>החלטות ועד הבית ופרוטוקולי אסיפות דיירים, להורדה כ-PDF</p>
        </div>
      </div>
      <div className="card">
        <div className="dec-tools">
          <div className="srch">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חיפוש החלטה או פרוטוקול…"
              aria-label="חיפוש החלטה או פרוטוקול"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty" style={{ padding: '48px 16px' }}>
            <h2 style={{ fontSize: 18 }}>לא נמצאו תוצאות</h2>
            <p style={{ fontSize: 14 }}>נסו מילת חיפוש אחרת או נקו את החיפוש.</p>
          </div>
        ) : (
          <div>
            {visible.map(({ d, year, opensYear }) => {
              const open = openId === d.id;
              const isProtocol = d.doc_type === 'protocol';
              const fileHref: string | undefined = staffFileUrls
                ? staffFileUrls[d.id]
                : `/api/portal/decisions/${d.id}/file`;
              return (
                <div key={d.id}>
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
                            className={isProtocol ? 'tag t-green' : 'tag'}
                            style={isProtocol ? undefined : { background: 'var(--brand-soft)', color: 'var(--brand-ink)' }}
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
                        <div className="dlock">תצוגה בלבד — פתיחת המסמך והורדתו דורשות הרשאת „החלטות ופרוטוקולים”.</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
