// The ONE toast that follows issuing a request from its form (there is no results
// screen any more): how many suppliers it went to, and the ones it did not.

export interface IssueResult {
  supplier_id: string;
  supplier_name: string;
  channel: 'email' | 'whatsapp';
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface IssueSummaryInput {
  /** "בקשה להצעת מחיר מספר 7" */
  heading: string;
  /** A channel was ticked, so a send was attempted. */
  sending: boolean;
  /** Per supplier and channel, as the send route returned; null when the request itself failed. */
  results: IssueResult[] | null;
  sendError?: string | null;
  /** Appended when the number the user saw was taken meanwhile. */
  note?: string | null;
}

export interface IssueSummary {
  level: 'success' | 'warning' | 'error';
  message: string;
}

const suppliersWord = (n: number) => (n === 1 ? 'לספק אחד' : `ל-${n} ספקים`);

export function buildIssueSummary(i: IssueSummaryInput): IssueSummary {
  const tail = i.note ? ` (${i.note})` : '';
  if (!i.sending) return { level: 'success', message: `${i.heading} הופקה בלי שליחה${tail}` };
  if (!i.results) {
    return { level: 'error', message: `${i.heading} הופקה, אך השליחה נכשלה${i.sendError ? `: ${i.sendError}` : ''}${tail}` };
  }

  // A supplier counts as reached when at least one channel got through.
  const bySupplier = new Map<string, { name: string; ok: boolean; skipped: boolean; failed: boolean }>();
  for (const r of i.results) {
    const s = bySupplier.get(r.supplier_id) ?? { name: r.supplier_name, ok: false, skipped: false, failed: false };
    if (r.ok) s.ok = true;
    else if (r.skipped) s.skipped = true;
    else s.failed = true;
    bySupplier.set(r.supplier_id, s);
  }
  const all = [...bySupplier.values()];
  const reached = all.filter((s) => s.ok).length;
  const skipped = all.filter((s) => !s.ok && !s.failed && s.skipped).map((s) => s.name);
  const failed = all.filter((s) => !s.ok && s.failed).map((s) => s.name);

  const parts: string[] = [];
  parts.push(reached > 0 ? `${i.heading} הופקה ונשלחה ${suppliersWord(reached)}` : `${i.heading} הופקה, אך לא נשלחה לאף ספק`);
  if (skipped.length) parts.push(`דולגו (חסר מייל או טלפון): ${skipped.join(', ')}`);
  if (failed.length) parts.push(`השליחה נכשלה: ${failed.join(', ')}`);
  const message = `${parts.join(' · ')}${tail}`;

  if (skipped.length === 0 && failed.length === 0) return { level: 'success', message };
  return { level: reached === 0 && failed.length > 0 ? 'error' : 'warning', message };
}
