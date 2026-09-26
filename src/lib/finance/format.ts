// ₪ formatting of the finance module. Entries carry agorot (numeric(12,2)), so
// unlike the debt tables (whole shekels) this keeps up to 2 decimals and drops
// them when the amount is whole. Render inside dir="ltr" + font-num.
const fmt = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function ils(value: number): string {
  return `₪ ${fmt.format(value)}`;
}

/** Amount as the user typed it back into an input ("1234.5", never "1,234.50"). */
export function amountToInput(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}
