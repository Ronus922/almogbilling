import type { RefObject } from 'react';

/**
 * ה-API הציבורי של <DateRangePicker /> — בדיוק כמו בסעיף 4 של "סקיל - בורר תאריכים.md".
 * תאריכים הם מחרוזות YYYY-MM-DD בלבד. `end` הוא יום העזיבה, לא הלילה האחרון.
 */
export type DateRange = { start: string | null; end: string | null };

export type DateRangePickerLayout = 'auto' | 'side-by-side' | 'stacked' | 'sheet';

export interface DateRangePickerProps {
  value: DateRange;
  /** נקרא בזמן הבחירה (עדכון חי של הטופס) */
  onChange: (r: DateRange) => void;
  /** "סגור" */
  onCommit?: (r: DateRange) => void;
  /** אחרי שחזור הערך */
  onCancel?: () => void;
  /** במקום blockPast; ברירת מחדל: אין */
  minDate?: string;
  maxDate?: string;
  /** מקסימום לילות בסטפר. אופציונלי: בלי ערך — אין מגבלה, [+] לא נעול לעולם. המינימום תמיד לילה אחד. */
  maxNights?: number;
  /** חסימות נקודתיות (חדר סגור, תפוסה) */
  isDateDisabled?: (d: string) => boolean;
  /** ברירת מחדל true */
  showStepper?: boolean;
  /** ברירת מחדל "שינוי מזיז את תאריך היציאה" */
  stepperHint?: string;
  /** ברירת מחדל auto: ‎≥768px → side-by-side, אחרת sheet */
  layout?: DateRangePickerLayout;
  footerHint?: { done: string; pending: string };
  /** ברירת מחדל "בחירת תאריכי שהייה" */
  sheetTitle?: string;
  /** ניתן להזרקה לבדיקות/דמו (2026-07-04) */
  today?: string;
  /** "בחרו תאריכים" */
  placeholder?: string;
  /**
   * פתיחה מבוקרת מבחוץ (טריגר חיצוני). בלי ערך — הרכיב מנהל את הפתיחה בעצמו מהשדה שלו.
   * עם ערך: true → נפתח (snapshot לשחזור), והסגירה מדווחת ב-onCommit / onCancel; המארח מחזיר false.
   */
  open?: boolean;
  /** הטריגר החיצוני: עוגן המיקום של הפופאובר, יעד החזרת הפוקוס, ולחיצה עליו אינה "לחיצה בחוץ" */
  anchorRef?: RefObject<HTMLElement | null>;
  /** לא לרנדר את שדה הטריגר והסטפר — כשהמארח מספק טריגר משלו (anchorRef) */
  hideTrigger?: boolean;
  /** קלאס נוסף על שורש הרכיב, הפופאובר וה-Sheet (שמרונדרים ב-portal) — לדריסת משתני --drp-* */
  className?: string;
}
