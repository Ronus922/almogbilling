'use client';
/**
 * <DateRangePicker /> — בורר טווח תאריכים (הגעה/עזיבה + סטפר לילות). רכיב מבוקר (controlled).
 * הטריגר, בחירת התבנית (auto / side-by-side / stacked / sheet) והחיבור בין הלוגיקה לתצוגה.
 * ה-API: ref/סקיל - בורר תאריכים.md סעיף 4.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { DesktopPopover } from './DesktopPopover';
import { MobileSheet } from './MobileSheet';
import { NightsStepper } from './NightsStepper';
import { formatRangeText, monthOf, todayKey, type DateKey, type YearMonth } from './dateUtils';
import { useMediaQuery } from './hooks';
import { TEXTS } from './texts';
import type { DateRangePickerProps } from './types';
import { useRangeSelection } from './useRangeSelection';
import { Icon } from './Icon';

/** ההחלטה דסקטופ/מובייל לפי רוחב החלון, לא לפי רוחב המיכל */
export const MOBILE_QUERY = '(max-width: 767px)';

/** החודש שבו נפתח הלוח: חודש ההגעה; אם אין — החודש של היום (או של minDate אם הוא מאוחר יותר). */
export function initialMonth(start: string | null, today: DateKey, minDate?: string): YearMonth {
  if (start) return monthOf(start);
  return monthOf(minDate && minDate > today ? minDate : today);
}

export function DateRangePicker({
  value,
  onChange,
  onCommit,
  onCancel,
  minDate,
  maxDate,
  maxNights,
  isDateDisabled,
  showStepper = true,
  stepperHint = TEXTS.stepperHint,
  layout = 'auto',
  footerHint,
  sheetTitle = TEXTS.sheetTitle,
  today: todayProp,
  placeholder = TEXTS.placeholder,
  open: openProp,
  anchorRef,
  hideTrigger = false,
  className,
}: DateRangePickerProps) {
  const today = todayProp ?? todayKey();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const mode = layout === 'auto' ? (isMobile ? 'sheet' : 'side-by-side') : layout;
  const reactId = useId();
  const dialogId = `drp-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<YearMonth>(() => initialMonth(value.start, today, minDate));
  const [sheetAnchor, setSheetAnchor] = useState<YearMonth>(view);
  const [monthCount, setMonthCount] = useState(3);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const sel = useRangeSelection({
    value,
    onChange,
    minDate,
    maxDate,
    maxNights,
    isDateDisabled,
  });

  /** טריגר חיצוני (anchorRef) קודם לשדה הפנימי: עוגן, החזרת פוקוס ו"לא לחיצה בחוץ" */
  const anchor = anchorRef ?? triggerRef;
  const insideRef = hideTrigger && anchorRef ? anchorRef : rootRef;
  const rootClass = className ? `drp-root ${className}` : 'drp-root';
  const focusTrigger = () => anchor.current?.focus({ preventScroll: true });

  const openPicker = () => {
    sel.snapshot();
    const m = initialMonth(value.start, today, minDate);
    setView(m);
    setSheetAnchor(m);
    setMonthCount(3);
    setOpen(true);
  };

  const handleCancel = (restoreFocus = true) => {
    sel.cancel();
    setOpen(false);
    if (restoreFocus) focusTrigger();
    onCancel?.();
  };

  const handleCommit = () => {
    if (!sel.canCommit) return;
    const committed = sel.commit();
    setOpen(false);
    focusTrigger();
    onCommit?.(committed);
  };

  /** הסטפר משנה רק את היציאה, ומחזיר את התצוגה לחודש ההגעה */
  const handleSetNights = (n: number) => {
    sel.setNights(n);
    if (value.start) setView(monthOf(value.start));
  };

  // פתיחה מבוקרת: true → פתיחה עם snapshot; false → סגירה בלי שחזור (המארח כבר קיבל את התוצאה)
  const openPickerRef = useRef(openPicker);
  openPickerRef.current = openPicker;
  useEffect(() => {
    if (openProp === undefined) return;
    if (openProp) openPickerRef.current();
    else setOpen(false);
  }, [openProp]);

  // Esc ברמת המסמך — גיבוי למקרה שהפוקוס מחוץ לדיאלוג (למשל אחרי לחיצה על הסטפר החיצוני)
  const cancelRef = useRef(handleCancel);
  cancelRef.current = handleCancel;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        cancelRef.current(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const hasEnd = !!value.start && !!value.end;
  const rangeText = formatRangeText(value.start, value.end, placeholder);
  const hint = footerHint ?? (mode === 'sheet' ? TEXTS.mobileHint : TEXTS.desktopHint);

  const sheet = open && mode === 'sheet' && (
    <MobileSheet
      id={dialogId}
      className={className}
      sel={sel}
      today={today}
      anchorMonth={sheetAnchor}
      monthCount={monthCount}
      onMoreMonths={() => setMonthCount((c) => c + 3)}
      sheetTitle={sheetTitle}
      footerHint={hint}
      showStepper={showStepper}
      onSetNights={handleSetNights}
      onCancel={() => handleCancel(true)}
      onCommit={handleCommit}
    />
  );

  const popover = open && mode !== 'sheet' && (
    <DesktopPopover
      id={dialogId}
      className={className}
      layout={mode}
      anchorRef={anchor}
      rootRef={insideRef}
      sel={sel}
      view={view}
      onViewChange={setView}
      today={today}
      placeholder={placeholder}
      footerHint={hint}
      onCancel={handleCancel}
      onCommit={handleCommit}
    />
  );

  // טריגר חיצוני: הרכיב מרנדר רק את הדיאלוג (portal), בלי שורה בעמוד
  if (hideTrigger) {
    return (
      <>
        {sheet}
        {popover}
      </>
    );
  }

  return (
    <div ref={rootRef} className={`${rootClass} drp`}>
      <div className="drp-top">
        <button
          ref={triggerRef}
          type="button"
          className={open ? 'drp-field drp-on' : 'drp-field'}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          onClick={() => (open ? handleCancel(true) : openPicker())}
        >
          <Icon name="calendar_month" />
          <span className="drp-field-text">{rangeText}</span>
          {mode !== 'sheet' && (
            <Icon name={open ? 'expand_less' : 'expand_more'} className="drp-chev" />
          )}
        </button>

        {showStepper && mode !== 'sheet' && (
          <div className="drp-stepw">
            <NightsStepper
              nights={sel.nights}
              hasRange={hasEnd}
              hasStart={!!value.start}
              canDec={sel.canDec}
              canInc={sel.canInc}
              onDec={() => handleSetNights(sel.nights - 1)}
              onInc={() => handleSetNights(sel.nights + 1)}
              onSetNights={handleSetNights}
            />
            <span className="drp-hint">{stepperHint}</span>
          </div>
        )}
      </div>

      {sheet}
      {popover}
    </div>
  );
}
