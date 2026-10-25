// One toast for a send made from the document window (re-send to a supplier, or suppliers added
// to an issued request): who it reached, who was skipped (no e-mail / phone) and who failed.

export interface SendResult {
  supplier_id: string;
  supplier_name: string;
  channel: 'email' | 'whatsapp';
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export function summarizeSend(results: readonly SendResult[]): { level: 'success' | 'warning' | 'error'; message: string } {
  const by = new Map<string, { name: string; ok: boolean; skipped: boolean; failed: boolean }>();
  for (const r of results) {
    const s = by.get(r.supplier_id) ?? { name: r.supplier_name, ok: false, skipped: false, failed: false };
    if (r.ok) s.ok = true;
    else if (r.skipped) s.skipped = true;
    else s.failed = true;
    by.set(r.supplier_id, s);
  }
  const all = [...by.values()];
  const reached = all.filter((s) => s.ok).length;
  const skipped = all.filter((s) => !s.ok && !s.failed && s.skipped).map((s) => s.name);
  const failed = all.filter((s) => !s.ok && s.failed).map((s) => s.name);
  const parts = [reached > 0 ? (reached === 1 ? 'הבקשה נשלחה לספק אחד' : `הבקשה נשלחה ל-${reached} ספקים`) : 'הבקשה לא נשלחה לאף ספק'];
  if (skipped.length) parts.push(`דולגו (חסר מייל או טלפון): ${skipped.join(', ')}`);
  if (failed.length) parts.push(`השליחה נכשלה: ${failed.join(', ')}`);
  const message = parts.join(' · ');
  if (!skipped.length && !failed.length) return { level: 'success', message };
  return { level: reached === 0 && failed.length > 0 ? 'error' : 'warning', message };
}
