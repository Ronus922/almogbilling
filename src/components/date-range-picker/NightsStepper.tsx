'use client';
/**
 * NightsStepper — [−] N [+] ב-LTR. N הוא שדה קלט: אפשר להקליד מספר לילות ידנית (למשל 30).
 * חילול ב-Enter וב-blur (לא בכל הקשה). אחרי Enter הפוקוס נשאר בשדה וכל הטקסט נבחר מחדש (כמו בכניסה),
 * כך שהקלדה נוספת מחליפה את הערך. Esc משחזר את הערך הקודם ולא סוגר את הבורר, חיצים למעלה/למטה = ±1.
 * ריק / 0 / לא מספר → חוזר לערך הקודם. החיתוך ל-maxNights והקטיעה בחסימה נעשים ב-useRangeSelection, כמו בכפתורים.
 * השדה נעול (readOnly, מציג —) כל עוד אין תאריך הגעה. הכפתורים נעולים כל עוד אין טווח מלא.
 * variant 'field' = ליד שדה התאריכים (52px, כפתורים 44px), 'sheet' = בתוך ה-Bottom Sheet (כפתורים 38px).
 */
import {
  useEffect, useRef, useState,
  type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent,
} from 'react';
import { Icon } from './Icon';
import { TEXTS } from './texts';

export interface NightsStepperProps {
  nights: number;
  /** יש טווח מלא (הגעה + יציאה): הכפתורים פעילים והשדה מציג מספר */
  hasRange: boolean;
  /** יש תאריך הגעה: השדה פתוח להקלדה. בלי הגעה — readOnly ומציג — */
  hasStart: boolean;
  canDec: boolean;
  canInc: boolean;
  onDec: () => void;
  onInc: () => void;
  /** חילול ערך שהוקלד: end = start + n, בדיוק כמו [+]/[−] */
  onSetNights: (n: number) => void;
  variant?: 'field' | 'sheet';
}

/** ספרות בלבד, לפחות 1. אחרת null = לא תקין. */
export function parseNights(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export function NightsStepper({
  nights,
  hasRange,
  hasStart,
  canDec,
  canInc,
  onDec,
  onInc,
  onSetNights,
  variant = 'field',
}: NightsStepperProps) {
  /** הטקסט בזמן עריכה; null = לא בעריכה, מציגים את הערך מה-props */
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectOnMouseUp = useRef(false);
  /** אחרי חילול ב-Enter: לבחור את כל הטקסט ברגע שהערך החדש מרונדר */
  const selectAfterCommit = useRef(false);
  const editable = hasStart;
  const shown = draft ?? (hasRange ? String(nights) : TEXTS.empty);

  useEffect(() => {
    if (!selectAfterCommit.current) return;
    selectAfterCommit.current = false;
    const el = inputRef.current;
    if (el && document.activeElement === el) el.select();
  });

  const commitDraft = () => {
    if (draft === null) return;
    const n = parseNights(draft);
    setDraft(null);
    if (n !== null) onSetNights(n);
  };

  const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
    if (!editable) return;
    setDraft(hasRange ? String(nights) : '');
    // הטקסט נבחר כולו בכניסה כדי שאפשר להקליד ישר מספר חדש
    e.currentTarget.select();
  };

  const handleMouseDown = () => {
    if (editable && document.activeElement !== inputRef.current) selectOnMouseUp.current = true;
  };

  const handleMouseUp = (e: MouseEvent<HTMLInputElement>) => {
    // הלחיצה שהכניסה פוקוס לא מבטלת את הבחירה המלאה
    if (selectOnMouseUp.current) {
      e.preventDefault();
      selectOnMouseUp.current = false;
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!editable) return;
    setDraft(e.target.value.replace(/\D/g, ''));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!editable) return;
    if (e.key === 'Enter') {
      e.preventDefault(); // לא שולח את הטופס המארח
      if (draft === null) {
        inputRef.current?.select();
        return;
      }
      selectAfterCommit.current = true;
      commitDraft();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); // הבורר לא נסגר
      e.stopPropagation();
      setDraft(null);
      inputRef.current?.select();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const current = parseNights(draft ?? '') ?? (hasRange ? nights : 0);
      const next = Math.max(1, current + (e.key === 'ArrowUp' ? 1 : -1));
      setDraft(null);
      onSetNights(next);
    }
  };

  return (
    <div
      className={variant === 'sheet' ? 'drp-step drp-step-sheet' : 'drp-step'}
      role="group"
      aria-label={TEXTS.stepperLabel}
    >
      <button
        type="button"
        className="drp-step-btn"
        onClick={onDec}
        disabled={!canDec}
        aria-label={TEXTS.stepperDec}
      >
        <Icon name="remove" />
      </button>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        className="drp-step-v drp-step-in drp-num"
        value={shown}
        readOnly={!editable}
        aria-label={TEXTS.stepperLabel}
        aria-readonly={!editable || undefined}
        dir="ltr"
        style={{ width: `${Math.max(shown.length, 1) + 1}ch` }}
        onFocus={handleFocus}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onChange={handleChange}
        onBlur={commitDraft}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        className="drp-step-btn"
        onClick={onInc}
        disabled={!canInc}
        aria-label={TEXTS.stepperInc}
      >
        <Icon name="add" />
      </button>
    </div>
  );
}
