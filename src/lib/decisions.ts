// Decisions & protocols (public.portal_decisions) — the single source of truth
// for what may be uploaded, how a row is labelled and how it is searched.
// Isomorphic on purpose (no DB, no server-only): the CRM panel pre-checks a
// file with it, the upload route ENFORCES it (the server is authoritative),
// and the portal tab formats its rows with it — so the two screens cannot
// drift apart. Same shape as lib/constants/reminderAttachments.ts.
import { mimeMatchesExt } from '@/lib/constants/whatsappAttachments';

const MB = 1024 * 1024;

/** PDF only, up to the server's ceiling. 50MB is the self-hosted Storage
 *  FILE_SIZE_LIMIT (shared infra, /opt/supabase/docker/docker-compose.yml), so
 *  it is the real wall — a bigger file fails at Storage, not here. */
export const DECISION_FILE = {
  ext: 'pdf',
  mime: 'application/pdf',
  accept: '.pdf,application/pdf',
  maxBytes: 50 * MB,
} as const;

export const DECISION_TYPES = ['decision', 'protocol'] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const DECISION_TYPE_LABEL: Record<DecisionType, string> = {
  decision: 'החלטה',
  protocol: 'פרוטוקול',
};

export const DECISION_TITLE_MAX = 200;
export const DECISION_SUMMARY_MAX = 2000;
export const DECISION_NUMBER_MAX = 40;

export function isDecisionType(v: unknown): v is DecisionType {
  return typeof v === 'string' && (DECISION_TYPES as readonly string[]).includes(v);
}

/** What the portal and the CRM both show as the row's type tag: a decision
 *  carries its number when it has one ("החלטה 14/2026"), a protocol never
 *  does — decision_number is meaningless for one and the panel hides the
 *  field entirely when the type is "פרוטוקול". */
export function decisionTypeTag(docType: DecisionType, decisionNumber: string | null): string {
  if (docType === 'protocol') return DECISION_TYPE_LABEL.protocol;
  const n = decisionNumber?.trim();
  return n ? `${DECISION_TYPE_LABEL.decision} ${n}` : DECISION_TYPE_LABEL.decision;
}

export interface DecisionFileCandidate {
  name: string;
  size: number;
  /** Browser-reported MIME ('' when unknown). */
  type?: string;
}

/** Validate the file (extension + MIME + size). A short Hebrew reason, or null
 *  when it is fine. Pure — the same verdict on client and server. */
export function validateDecisionFile(file: DecisionFileCandidate): string | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(file.name.trim());
  if (!m || m[1].toLowerCase() !== DECISION_FILE.ext) return 'יש להעלות קובץ PDF';
  if (!mimeMatchesExt(DECISION_FILE.ext, file.type ?? '')) return 'תוכן הקובץ אינו PDF';
  if (file.size <= 0) return 'הקובץ ריק';
  if (file.size > DECISION_FILE.maxBytes) return 'הקובץ גדול מ-50MB';
  return null;
}

// ── Formats (the reference's) ────────────────────────────────────────────────

/** '412 KB' / '1.1 MB' — the reference's file-size column. */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const n = v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n} ${units[i]}`;
}

/** 'YYYY-MM-DD' (what the API carries) → '08.09.2026' (what both screens show).
 *  Never Date-parsed: a date column is a calendar day, and a timezone shift
 *  would move it. */
export function formatDecisionDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : isoDate;
}

/** The year separator of the portal list. */
export function decisionYear(isoDate: string): string {
  return isoDate.slice(0, 4);
}

/** The portal's live search: title + summary, case-insensitive, trimmed.
 *  An empty query matches everything. */
export function matchesDecisionQuery(
  row: { title: string; summary: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.title} ${row.summary ?? ''}`.toLowerCase().includes(q);
}
