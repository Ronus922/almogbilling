// Pure helpers for the dashboard freshness indicator (LastImportIndicator).
// Severity is driven by the last *import* only — it reflects how fresh the data
// in the system is. Sync is shown alongside but never changes the severity.

export type Severity = 'ok' | 'yellow' | 'red';

/**
 * Freshness severity from the last import time:
 *   < 24h → ok · 24–48h → yellow · > 48h or never → red.
 */
export function computeSeverity(lastImportAt: Date | null, now: number): Severity {
  if (!lastImportAt) return 'red';
  const hours = (now - lastImportAt.getTime()) / 36e5;
  if (hours > 48) return 'red';
  if (hours > 24) return 'yellow';
  return 'ok';
}
