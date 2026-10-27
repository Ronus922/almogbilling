'use client';
/**
 * DesktopPopover — פופאובר מתחת לשדה (≥768px): כותרת סיכום → שני חודשים זה לצד זה
 * (נוכחי מימין, הבא משמאל, חיצים משותפים בקצוות) → פוטר. layout="stacked" מוריד את החודש השני מתחת לראשון.
 * מיקום: מתחת לשדה, מיושר לימין, 16px; אם אין מקום — מעל; אם חורג — מוצמד לשוליים 16px. לחיצה בחוץ = ביטול.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import {
  addMonths, formatRangeText, formatShort, monthIndex, monthOf, type DateKey, type YearMonth,
} from './dateUtils';
import { dayButton, keyboardStep, pickTabKey, useFocusTrap } from './hooks';
import { MonthGrid } from './MonthGrid';
import { TEXTS, nightsTitle } from './texts';
import { buildMonths, monthSequence, type RangeSelection } from './useRangeSelection';

export interface DesktopPopoverProps {
  id: string;
  /** קלאס נוסף לשורש (דריסת משתני --drp-* מהמארח) */
  className?: string;
  layout: 'side-by-side' | 'stacked';
  /** שדה התאריכים — העוגן למיקום */
  anchorRef: RefObject<HTMLElement | null>;
  /** השורה העליונה (שדה + סטפר): לחיצה בתוכה אינה "לחיצה בחוץ" */
  rootRef: RefObject<HTMLElement | null>;
  sel: RangeSelection;
  /** החודש הימני המוצג */
  view: YearMonth;
  onViewChange: (ym: YearMonth) => void;
  today: DateKey;
  placeholder: string;
  footerHint: { done: string; pending: string };
  /** restoreFocus=false כשהסגירה באה מלחיצה מחוץ לפופאובר (הפוקוס כבר עבר לאלמנט אחר) */
  onCancel: (restoreFocus: boolean) => void;
  onCommit: () => void;
}

export interface PopoverPosition {
  top: number;
  left: number;
  width: number;
}

const GAP = 16;
const MARGIN = 16;
const MIN_WIDTH = 700;
const MAX_WIDTH = 940;
/** stacked: רוחב השורה, אך מתחת לסף העטיפה של flex-wrap (300+300+18 + ריפוד 44 + מסגרת 2 = 664) */
const STACKED_MIN_WIDTH = 320;
const STACKED_MAX_WIDTH = 640;

/** חישוב טהור של מיקום הפופאובר — ניתן לבדיקה בלי DOM. */
export function computePopoverPosition(
  anchor: { top: number; bottom: number; right: number; width: number },
  popHeight: number,
  vw: number,
  vh: number,
  layout: 'side-by-side' | 'stacked',
): PopoverPosition {
  const avail = Math.max(vw - 2 * MARGIN, 0);
  const width =
    layout === 'stacked'
      ? Math.min(STACKED_MAX_WIDTH, Math.max(STACKED_MIN_WIDTH, anchor.width), avail)
      : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, anchor.width), avail);

  let top = anchor.bottom + GAP;
  const below = top + popHeight <= vh - MARGIN;
  const above = anchor.top - GAP - popHeight;
  if (!below && above >= MARGIN) top = above;
  // לא נכנס לא מתחת ולא מעל (חלון נמוך): מוצמד לשוליים התחתונים, הפופאובר גולל בפנים
  else if (!below) top = Math.max(MARGIN, vh - MARGIN - popHeight);

  let left = anchor.right - width;
  if (left + width > vw - MARGIN) left = vw - MARGIN - width;
  if (left < MARGIN) left = MARGIN;

  return { top, left, width };
}

export function DesktopPopover({
  id,
  className,
  layout,
  anchorRef,
  rootRef,
  sel,
  view,
  onViewChange,
  today,
  placeholder,
  footerHint,
  onCancel,
  onCommit,
}: DesktopPopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const calRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const [focusKey, setFocusKey] = useState<DateKey | null>(sel.start);
  const pendingFocus = useRef<DateKey | null>(null);

  const months = useMemo(
    () =>
      buildMonths(monthSequence(view, 2), true, {
        range: { start: sel.start, end: sel.end },
        effEnd: sel.effEnd,
        today,
        rules: sel.rules,
      }),
    [view, sel.start, sel.end, sel.effEnd, today, sel.rules],
  );
  const tabKey = useMemo(
    () => pickTabKey(months, [focusKey, sel.start, today]),
    [months, focusKey, sel.start, today],
  );

  // ---- מיקום ----
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const field = anchor.getBoundingClientRect();
    // הרוחב והקצה התחתון נגזרים מהשורה העליונה כולה (שדה + סטפר + תווית),
    // היישור — לקצה הימני של השדה. כך הפופאובר לא מכסה את תווית הסטפר.
    const row = rootRef.current?.getBoundingClientRect() ?? field;
    const rect = {
      top: field.top,
      bottom: Math.max(field.bottom, row.bottom),
      right: field.right,
      width: Math.max(field.width, row.width),
    };
    // קודם הרוחב (כדי שהגובה יימדד אחרי העטיפה), ואז המיקום לפי הגובה בפועל
    pop.style.width = `${computePopoverPosition(rect, 0, vw, vh, layout).width}px`;
    const next = computePopoverPosition(rect, pop.offsetHeight, vw, vh, layout);
    setPos((p) =>
      p && p.top === next.top && p.left === next.left && p.width === next.width ? p : next,
    );
  }, [anchorRef, rootRef, layout]);

  useLayoutEffect(() => {
    updatePosition();
  });

  useEffect(() => {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  // ---- לחיצה מחוץ לפופאובר = ביטול ----
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t) || rootRef.current?.contains(t)) return;
      onCancel(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onCancel, rootRef]);

  // ---- פוקוס ----
  // המלכודת כוללת גם את השורה העליונה (שדה + סטפר + שדה הלילות)
  useFocusTrap(popRef, (root) => dayButton(root, sel.start) ?? dayButton(root, tabKey), rootRef);

  useEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    const el = dayButton(calRef.current, k);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const handleCalKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = (e.target as HTMLElement).dataset?.key;
    if (!current) return;
    const next = keyboardStep(e.key, current);
    if (!next) return;
    e.preventDefault();
    const nm = monthOf(next);
    const ni = monthIndex(nm);
    const vi = monthIndex(view);
    if (ni < vi) onViewChange(nm);
    else if (ni > vi + 1) onViewChange(addMonths(nm.y, nm.m, -1));
    setFocusKey(next);
    pendingFocus.current = next;
  };

  const handleDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel(true);
    }
  };

  const hasEnd = !!sel.start && !!sel.end;
  const titleId = `${id}-title`;

  return createPortal(
    <div
      ref={popRef}
      id={id}
      className={className ? `drp-root drp-pop ${className}` : 'drp-root drp-pop'}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={
        pos
          ? { top: pos.top, left: pos.left, width: pos.width }
          : { top: 0, left: 0, visibility: 'hidden' }
      }
      onKeyDown={handleDialogKeyDown}
    >
      <div className="drp-pop-h">
        <span className="drp-moon">
          <Icon name="bedtime" />
        </span>
        <div>
          <div className="drp-sum-t" id={titleId}>
            {nightsTitle(sel.nights, hasEnd)}
          </div>
          <div className="drp-sum-s">{formatRangeText(sel.start, sel.end, placeholder)}</div>
        </div>
        <div className="drp-ft">
          <div className="drp-ft-col">
            <span className="drp-ft-l">{TEXTS.from}</span>
            <span className="drp-ft-v drp-num">{sel.start ? formatShort(sel.start) : TEXTS.empty}</span>
          </div>
          <span className="drp-ft-chip">
            <Icon name="bedtime" />
            <span className="drp-num">{hasEnd ? sel.nights : TEXTS.empty}</span>
          </span>
          <div className="drp-ft-col">
            <span className="drp-ft-l">{TEXTS.to}</span>
            <span className={hasEnd ? 'drp-ft-v drp-num' : 'drp-ft-v drp-num drp-dim'}>
              {sel.end ? formatShort(sel.end) : TEXTS.empty}
            </span>
          </div>
        </div>
      </div>

      <div
        ref={calRef}
        className={layout === 'stacked' ? 'drp-cal drp-stacked' : 'drp-cal'}
        onMouseLeave={() => sel.setHover(null)}
        onKeyDown={handleCalKeyDown}
      >
        {months.map((m, i) => {
          const monthTitleId = `${id}-m${i}`;
          const isFirst = i === 0;
          const isLast = i === months.length - 1;
          return (
            <MonthGrid
              key={`${m.y}-${m.m}`}
              month={m}
              className="drp-mo"
              showWeekdays
              tabKey={tabKey}
              hoverable
              titleId={monthTitleId}
              onPick={sel.pick}
              onHover={sel.setHover}
              onFocusDay={(k) => {
                setFocusKey(k);
                sel.setHover(k);
              }}
              header={
                <div className="drp-mo-h">
                  {isFirst ? (
                    <button
                      type="button"
                      className="drp-nav-b"
                      onClick={() => onViewChange(addMonths(view.y, view.m, -1))}
                      title={TEXTS.prevMonth}
                      aria-label={TEXTS.prevMonth}
                    >
                      <Icon name="chevron_right" />
                    </button>
                  ) : (
                    <span className="drp-nav-sp" />
                  )}
                  <span className="drp-mo-t" id={monthTitleId}>
                    {m.title}
                  </span>
                  {isLast ? (
                    <button
                      type="button"
                      className="drp-nav-b"
                      onClick={() => onViewChange(addMonths(view.y, view.m, 1))}
                      title={TEXTS.nextMonth}
                      aria-label={TEXTS.nextMonth}
                    >
                      <Icon name="chevron_left" />
                    </button>
                  ) : (
                    <span className="drp-nav-sp" />
                  )}
                </div>
              }
            />
          );
        })}
      </div>

      <div className="drp-foot">
        <span className="drp-foot-h" aria-live="polite">
          {hasEnd ? footerHint.done : footerHint.pending}
        </span>
        <button type="button" className="drp-btn-t" onClick={() => onCancel(true)}>
          {TEXTS.cancel}
        </button>
        <button type="button" className="drp-btn" onClick={onCommit} disabled={!sel.canCommit}>
          {TEXTS.close}
        </button>
      </div>
    </div>,
    document.body,
  );
}
