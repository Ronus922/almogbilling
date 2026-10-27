/**
 * hooks פנימיים של הרכיב: ברייקפוינט לפי רוחב חלון, מלכודת פוקוס, נעילת גלילת body,
 * וניווט מקלדת בלוח.
 */
import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react';
import { addDays, addMonths, daysInMonth, key, parse, type DateKey } from './dateUtils';
import type { MonthModel } from './useRangeSelection';

/** ההחלטה דסקטופ/מובייל לפי רוחב החלון (matchMedia), לא לפי רוחב המיכל. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  }, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * מלכודת פוקוס: בפתיחה הפוקוס עובר פנימה (initialFocus או הפריט הראשון),
 * ו-Tab / Shift+Tab מסתובבים בתוך המיכל. extraRef (אופציונלי) מצרף למלכודת מיכל נוסף שבא לפניו
 * בסדר הטאבים — בדסקטופ השורה העליונה (שדה התאריכים + הסטפר ושדה הלילות).
 * החזרת הפוקוס לטריגר נעשית ב-DateRangePicker.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  initialFocus?: (root: HTMLElement) => HTMLElement | null,
  extraRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const target = initialFocus?.(root) ?? focusablesIn(root)[0] ?? root;
    target.focus({ preventScroll: true });

    const roots = () =>
      [extraRef?.current ?? null, root].filter((r): r is HTMLElement => r !== null);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const active = document.activeElement;
      const all = roots();
      if (!all.some((r) => r.contains(active))) return;
      const items = all.flatMap((r) => focusablesIn(r));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // הפוקוס הראשוני נקבע פעם אחת בעת ההרכבה
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** body נעול לגלילה כל עוד ה-Sheet פתוח. */
export function useBodyScrollLock(): void {
  useEffect(() => {
    const { body } = document;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = prevOverflow;
    };
  }, []);
}

/** אותו יום בחודש אחר, עם חיתוך לסוף החודש (31 בינואר → 28 בפברואר). */
export function shiftMonthKeepDay(k: DateKey, delta: number): DateKey {
  const { y, m, d } = parse(k);
  const t = addMonths(y, m, delta);
  return key(t.y, t.m, Math.min(d, daysInMonth(t.y, t.m)));
}

/**
 * ניווט מקלדת בלוח (RTL): חץ שמאלה = יום הבא, חץ ימינה = יום קודם,
 * למעלה/למטה = שבוע, PageUp/PageDown = חודש. מחזיר null למקש שאינו ניווט.
 */
export function keyboardStep(keyName: string, current: DateKey): DateKey | null {
  switch (keyName) {
    case 'ArrowLeft':
      return addDays(current, 1);
    case 'ArrowRight':
      return addDays(current, -1);
    case 'ArrowUp':
      return addDays(current, -7);
    case 'ArrowDown':
      return addDays(current, 7);
    case 'PageUp':
      return shiftMonthKeepDay(current, -1);
    case 'PageDown':
      return shiftMonthKeepDay(current, 1);
    default:
      return null;
  }
}

/** הכפתור של יום נתון בתוך מיכל, לפי data-key */
export function dayButton(root: HTMLElement | null, k: DateKey | null): HTMLButtonElement | null {
  if (!root || !k) return null;
  return root.querySelector<HTMLButtonElement>(`.drp-d[data-key="${k}"]`);
}

/** היום שיקבל tabIndex=0: המועמד הראשון שמופיע בחודשים המוצגים, ואם אין — היום הראשון בלוח. */
export function pickTabKey(months: MonthModel[], candidates: (DateKey | null)[]): DateKey | null {
  const visible = new Set<string>();
  for (const m of months) for (const c of m.cells) if (c.key) visible.add(c.key);
  for (const c of candidates) if (c && visible.has(c)) return c;
  for (const m of months) for (const c of m.cells) if (c.key) return c.key;
  return null;
}
