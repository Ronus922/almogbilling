/** כל הטקסטים הקבועים של הרכיב (עברית), מרוכזים במקום אחד. */
export const TEXTS = {
  placeholder: 'בחרו תאריכים',
  pickDeparture: 'בחרו תאריך יציאה',
  nightsOne: 'לילה אחד',
  nightsMany: (n: number) => `${n} לילות`,
  from: 'מתאריך',
  to: 'עד תאריך',
  empty: '—',
  stepperHint: 'שינוי מזיז את תאריך היציאה',
  stepperLabel: 'מספר לילות',
  stepperDec: 'פחות לילה',
  stepperInc: 'עוד לילה',
  close: 'סגור',
  cancel: 'ביטול',
  closeX: 'סגירה',
  prevMonth: 'חודש קודם',
  nextMonth: 'חודש הבא',
  moreMonths: 'חודשים נוספים',
  sheetTitle: 'בחירת תאריכי שהייה',
  dialogLabel: 'בחירת טווח תאריכים',
  desktopHint: {
    done: 'התאריכים עודכנו בטופס — לשמירה לחצו שמור שינויים',
    pending: 'לחצו על תאריך היציאה כדי לסיים את הבחירה',
  },
  mobileHint: {
    done: 'התאריכים יעודכנו בטופס',
    pending: 'הקישו על תאריך היציאה לסיום הבחירה',
  },
} as const;

/** "6 לילות" / "לילה אחד" / "בחרו תאריך יציאה" */
export function nightsTitle(nights: number, hasEnd: boolean): string {
  if (!hasEnd) return TEXTS.pickDeparture;
  return nights === 1 ? TEXTS.nightsOne : TEXTS.nightsMany(nights);
}
