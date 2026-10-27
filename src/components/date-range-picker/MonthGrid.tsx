'use client';
/**
 * MonthGrid — חודש אחד, משותף לדסקטופ ולמובייל.
 * הפס (band) נצבע על התא (.drp-cell), לא על הכפתור (.drp-d). תא 44px, 7 עמודות 1fr, row-gap 6px.
 */
import type { ReactNode } from 'react';
import { WEEKDAY_LETTERS_HE, type DateKey } from './dateUtils';
import type { DayCell, MonthModel } from './useRangeSelection';

export interface MonthGridProps {
  month: MonthModel;
  /** קלאס העוטף: 'drp-mo' בדסקטופ, 'drp-m-mo' במובייל */
  className: string;
  /** כותרת החודש (עם או בלי חיצים), מרונדרת מעל הלוח */
  header?: ReactNode;
  /** שורת ימי השבוע בתוך החודש (דסקטופ). במובייל השורה קבועה מחוץ לגוף הגולל. */
  showWeekdays?: boolean;
  /** היום שמקבל tabIndex=0 (roving tabindex) */
  tabKey: DateKey | null;
  /** דסקטופ בלבד: ריחוף מצייר תצוגה מקדימה */
  hoverable?: boolean;
  titleId?: string;
  onPick: (k: DateKey) => void;
  onHover?: (k: DateKey) => void;
  onFocusDay?: (k: DateKey) => void;
}

export function WeekdayRow({ className }: { className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {WEEKDAY_LETTERS_HE.map((w) => (
        <span key={w}>{w}</span>
      ))}
    </div>
  );
}

function cellClass(c: DayCell): string {
  let cls = 'drp-cell';
  if (c.band === 'in') cls += ' drp-in';
  else if (c.band === 'bs') cls += ' drp-bs';
  else if (c.band === 'be') cls += ' drp-be';
  else if (c.band === 'bs be') cls += ' drp-bs drp-be';
  return cls;
}

function dayClass(c: DayCell): string {
  let cls = 'drp-d';
  if (c.state) cls += ` drp-${c.state}`;
  return cls;
}

export function MonthGrid({
  month,
  className,
  header,
  showWeekdays = false,
  tabKey,
  hoverable = false,
  titleId,
  onPick,
  onHover,
  onFocusDay,
}: MonthGridProps) {
  const rows: DayCell[][] = [];
  for (let r = 0; r < month.rows; r++) rows.push(month.cells.slice(r * 7, r * 7 + 7));

  return (
    <div className={className}>
      {header}
      {showWeekdays && <WeekdayRow className="drp-wd" />}
      <div
        className="drp-grid"
        role="grid"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : month.title}
      >
        {rows.map((row, ri) => (
          <div className="drp-row" role="row" key={ri}>
            {row.map((c, ci) => (
              <div
                key={ci}
                className={cellClass(c)}
                role="gridcell"
                aria-selected={c.key ? c.state === 'sel' : undefined}
              >
                {c.key && (
                  <button
                    type="button"
                    className={dayClass(c)}
                    data-key={c.key}
                    tabIndex={c.key === tabKey ? 0 : -1}
                    aria-label={c.label}
                    aria-disabled={c.disabled ? 'true' : undefined}
                    aria-current={c.state === 'today' ? 'date' : undefined}
                    onClick={() => onPick(c.key as DateKey)}
                    onMouseEnter={hoverable && onHover ? () => onHover(c.key as DateKey) : undefined}
                    onFocus={onFocusDay ? () => onFocusDay(c.key as DateKey) : undefined}
                  >
                    {c.day}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
