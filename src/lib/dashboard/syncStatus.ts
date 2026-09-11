// Pure helpers for the dashboard freshness indicator (LastImportIndicator).
// Severity is driven by how old the SOURCE data is — the moment Bllink was
// scraped (sync_runs.source_run_at of the last successful sync) — not by when
// it was last copied into this database.

export type Severity = 'ok' | 'yellow' | 'red';

/**
 * Freshness severity from the source-data time:
 *   < 24h → ok · 24h–maxAgeHours → yellow · older or never → red.
 * maxAgeHours matches the red banner / stage-'stale' threshold (default 36).
 */
export function computeSeverity(sourceRunAt: Date | null, now: number, maxAgeHours = 36): Severity {
  if (!sourceRunAt) return 'red';
  const hours = (now - sourceRunAt.getTime()) / 36e5;
  if (hours > maxAgeHours) return 'red';
  if (hours > 24) return 'yellow';
  return 'ok';
}
