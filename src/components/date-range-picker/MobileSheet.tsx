'use client';
/**
 * MobileSheet — Bottom Sheet (<768px) מ-48px מהקצה העליון: ידית → כותרת + X → שורת סיכום עם הסטפר
 * → ימי השבוע קבועים → חודשים בגלילה אנכית מחודש ההגעה + "חודשים נוספים" (+3) → פוטר קבוע.
 * אין hover ואין חיצי ניווט. body נעול לגלילה. רקע / X / ביטול / Esc / גרירת הידית למטה = ביטול.
 */
import {
  useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type TouchEvent as ReactTouchEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { formatShort, monthIndex, monthOf, type DateKey, type YearMonth } from './dateUtils';
import { dayButton, keyboardStep, pickTabKey, useBodyScrollLock, useFocusTrap } from './hooks';
import { MonthGrid, WeekdayRow } from './MonthGrid';
import { NightsStepper } from './NightsStepper';
import { TEXTS, nightsTitle } from './texts';
import { buildMonths, monthSequence, type RangeSelection } from './useRangeSelection';

export interface MobileSheetProps {
  id: string;
  /** קלאס נוסף לשורש (דריסת משתני --drp-* מהמארח) */
  className?: string;
  sel: RangeSelection;
  today: DateKey;
  /** החודש הראשון ברשימה (חודש ההגעה בעת הפתיחה) */
  anchorMonth: YearMonth;
  monthCount: number;
  onMoreMonths: () => void;
  sheetTitle: string;
  footerHint: { done: string; pending: string };
  showStepper: boolean;
  onSetNights: (n: number) => void;
  onCancel: () => void;
  onCommit: () => void;
}

const DRAG_DISMISS_PX = 80;

export function MobileSheet({
  id,
  className,
  sel,
  today,
  anchorMonth,
  monthCount,
  onMoreMonths,
  sheetTitle,
  footerHint,
  showStepper,
  onSetNights,
  onCancel,
  onCommit,
}: MobileSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<DateKey | null>(sel.start);
  const pendingFocus = useRef<DateKey | null>(null);
  const touchStartY = useRef<number | null>(null);

  useBodyScrollLock();
  // במובייל הפוקוס נכנס ל-Sheet עצמו (לא ליום) — בלי טבעת פוקוס ובלי קפיצת גלילה בהקשה
  useFocusTrap(sheetRef, (root) => root);

  const months = useMemo(
    () =>
      buildMonths(monthSequence(anchorMonth, monthCount), false, {
        range: { start: sel.start, end: sel.end },
        effEnd: sel.effEnd,
        today,
        rules: sel.rules,
      }),
    [anchorMonth, monthCount, sel.start, sel.end, sel.effEnd, today, sel.rules],
  );
  const tabKey = useMemo(
    () => pickTabKey(months, [focusKey, sel.start, today]),
    [months, focusKey, sel.start, today],
  );

  useEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    const el = dayButton(bodyRef.current, k);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const handleBodyKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = (e.target as HTMLElement).dataset?.key;
    if (!current) return;
    const next = keyboardStep(e.key, current);
    if (!next) return;
    e.preventDefault();
    const ni = monthIndex(monthOf(next));
    if (ni < monthIndex(anchorMonth)) return;
    const last = months[months.length - 1];
    if (ni > monthIndex(last)) onMoreMonths();
    setFocusKey(next);
    pendingFocus.current = next;
  };

  const handleDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  // גרירת הידית/הכותרת למטה = ביטול
  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const y0 = touchStartY.current;
    if (y0 === null) return;
    const y = e.touches[0]?.clientY ?? y0;
    if (y - y0 > DRAG_DISMISS_PX) {
      touchStartY.current = null;
      onCancel();
    }
  };
  const onTouchEnd = () => {
    touchStartY.current = null;
  };

  const hasEnd = !!sel.start && !!sel.end;
  const titleId = `${id}-title`;

  return createPortal(
    <div className={className ? `drp-root ${className}` : 'drp-root'}>
      <div className="drp-backdrop" onClick={onCancel} aria-hidden="true" />
      <div
        ref={sheetRef}
        id={id}
        className="drp-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div
          className="drp-sh-head"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="drp-grab" />
          <div className="drp-sh-h">
            <div>
              <div className="drp-sh-t" id={titleId}>
                {nightsTitle(sel.nights, hasEnd)}
              </div>
              <div className="drp-sum-s">{sheetTitle}</div>
            </div>
            <button
              type="button"
              className="drp-sh-x"
              onClick={onCancel}
              title={TEXTS.closeX}
              aria-label={TEXTS.closeX}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="drp-m-sum">
          <div className="drp-ft-col">
            <span className="drp-ft-l">{TEXTS.from}</span>
            <span className="drp-ft-v drp-num">{sel.start ? formatShort(sel.start) : TEXTS.empty}</span>
          </div>
          {showStepper && (
            <NightsStepper
              variant="sheet"
              nights={sel.nights}
              hasRange={hasEnd}
              hasStart={!!sel.start}
              canDec={sel.canDec}
              canInc={sel.canInc}
              onDec={() => onSetNights(sel.nights - 1)}
              onInc={() => onSetNights(sel.nights + 1)}
              onSetNights={onSetNights}
            />
          )}
          <div className="drp-ft-col drp-ft-end">
            <span className="drp-ft-l">{TEXTS.to}</span>
            <span className={hasEnd ? 'drp-ft-v drp-num' : 'drp-ft-v drp-num drp-dim'}>
              {sel.end ? formatShort(sel.end) : TEXTS.empty}
            </span>
          </div>
        </div>

        <WeekdayRow className="drp-m-wd" />

        <div ref={bodyRef} className="drp-m-body" onKeyDown={handleBodyKeyDown}>
          {months.map((m, i) => {
            const monthTitleId = `${id}-m${i}`;
            return (
              <MonthGrid
                key={`${m.y}-${m.m}`}
                month={m}
                className="drp-m-mo"
                tabKey={tabKey}
                titleId={monthTitleId}
                onPick={sel.pick}
                onFocusDay={setFocusKey}
                header={
                  <div className="drp-m-mo-t" id={monthTitleId}>
                    {m.title}
                  </div>
                }
              />
            );
          })}
          <button type="button" className="drp-m-more" onClick={onMoreMonths}>
            <Icon name="expand_more" />
            {TEXTS.moreMonths}
          </button>
        </div>

        <div className="drp-m-foot">
          <span className="drp-m-foot-h" aria-live="polite">
            {hasEnd ? footerHint.done : footerHint.pending}
          </span>
          <div className="drp-m-btns">
            <button type="button" className="drp-btn-sec" onClick={onCancel}>
              {TEXTS.cancel}
            </button>
            <button type="button" className="drp-btn" onClick={onCommit} disabled={!sel.canCommit}>
              {TEXTS.close}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
