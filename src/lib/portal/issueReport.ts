// Owners-portal fault report ("דיווח על תקלה", ref/issue-report-form.md) — the
// ONE definition of the form's rules. Isomorphic and pure on purpose: the
// screen validates with exactly the function the route enforces, so a report
// the screen accepts is a report the server accepts, and the other way round.
//
// Deliberate departures from the reference (decision 03/10/2026, they win over
// the ref files): photos only — no video at all; up to 5; no tracking screen
// and no WhatsApp updates; the apartment is never a form field (it comes from
// the session, server-side).
import { z } from 'zod';
import { ISSUE_ALLOWED_IMAGE_TYPES, ISSUE_MAX_IMAGE_SIZE_BYTES } from '@/lib/constants/issues';
import type { IssuePriority } from '@/lib/types/issues';

// ── Fields ────────────────────────────────────────────────────────────────────

export const PORTAL_ISSUE_LOCATION_MIN = 2;
export const PORTAL_ISSUE_LOCATION_MAX = 120;
export const PORTAL_ISSUE_AREA_MAX = 120;
export const PORTAL_ISSUE_DESCRIPTION_MIN = 5;
export const PORTAL_ISSUE_DESCRIPTION_MAX = 2000;

/** The quick chips under "מיקום" — a tap fills the field. */
export const PORTAL_ISSUE_LOCATION_CHIPS = ['לובי', 'חדר מדרגות', 'מעלית', 'חניון'] as const;

/**
 * The resident's three urgencies and the issue priority each one opens with
 * (decision 03/10/2026). One-to-one; the manager may change the priority later
 * in the issue panel like any other field. The staff screen labels `high`
 * "גבוהה" — the resident's "בינונית" is the same value.
 */
export const PORTAL_URGENCIES = [
  { key: 'regular', label: 'רגילה', priority: 'normal' },
  { key: 'medium', label: 'בינונית', priority: 'high' },
  { key: 'urgent', label: 'דחופה', priority: 'urgent' },
] as const satisfies ReadonlyArray<{ key: string; label: string; priority: IssuePriority }>;

export type PortalUrgency = (typeof PORTAL_URGENCIES)[number]['key'];
export const PORTAL_URGENCY_DEFAULT: PortalUrgency = 'regular';

export function urgencyToPriority(u: PortalUrgency): IssuePriority {
  return PORTAL_URGENCIES.find((x) => x.key === u)!.priority;
}

export function urgencyLabel(u: PortalUrgency): string {
  return PORTAL_URGENCIES.find((x) => x.key === u)!.label;
}

/** The issue's title, which the resident never types (decision 03/10/2026). */
export function portalIssueTitle(location: string): string {
  return `תקלה בשטח משותף: ${location}`;
}

export const PORTAL_ISSUE_MESSAGES = {
  locationRequired: 'יש לציין היכן התקלה',
  locationTooLong: `המיקום ארוך מדי (עד ${PORTAL_ISSUE_LOCATION_MAX} תווים)`,
  areaTooLong: `הקומה / האזור ארוכים מדי (עד ${PORTAL_ISSUE_AREA_MAX} תווים)`,
  descriptionRequired: 'יש לתאר את התקלה בכמה מילים',
  descriptionTooLong: `התיאור ארוך מדי (עד ${PORTAL_ISSUE_DESCRIPTION_MAX} תווים)`,
  urgencyInvalid: 'יש לבחור דחיפות',
} as const;

/**
 * FormData text → string. A multipart body sends every line break as CRLF, so
 * a description that fits 2000 characters on the screen would be longer on
 * the server; both sides count after folding CRLF to LF. A missing field (or a
 * File in a text slot) is the empty string, which then fails its own rule.
 */
const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : '');

const portalIssueReportSchema = z.object({
  location: z.preprocess(
    text,
    z.string().trim()
      .min(PORTAL_ISSUE_LOCATION_MIN, PORTAL_ISSUE_MESSAGES.locationRequired)
      .max(PORTAL_ISSUE_LOCATION_MAX, PORTAL_ISSUE_MESSAGES.locationTooLong),
  ),
  area: z.preprocess(text, z.string().trim().max(PORTAL_ISSUE_AREA_MAX, PORTAL_ISSUE_MESSAGES.areaTooLong)),
  description: z.preprocess(
    text,
    z.string().trim()
      .min(PORTAL_ISSUE_DESCRIPTION_MIN, PORTAL_ISSUE_MESSAGES.descriptionRequired)
      .max(PORTAL_ISSUE_DESCRIPTION_MAX, PORTAL_ISSUE_MESSAGES.descriptionTooLong),
  ),
  urgency: z.enum(
    PORTAL_URGENCIES.map((u) => u.key) as [PortalUrgency, ...PortalUrgency[]],
    { error: PORTAL_ISSUE_MESSAGES.urgencyInvalid },
  ),
});

export type PortalIssueField = 'location' | 'area' | 'description' | 'urgency';

export interface PortalIssueReport {
  location: string;
  /** null when the resident left "קומה / אזור" empty. */
  area: string | null;
  description: string;
  urgency: PortalUrgency;
}

/** The 201 of POST /api/portal/issues — everything the confirmation screen
 *  (state 04) prints, and nothing else: no issue id, no row. The resident never
 *  reads an issue back. */
export interface PortalIssueReceipt {
  ticketNumber: number;
  location: string;
  area: string | null;
  urgency: PortalUrgency;
  imageCount: number;
}

export type PortalIssueValidation =
  | { ok: true; value: PortalIssueReport }
  | { ok: false; errors: Partial<Record<PortalIssueField, string>> };

/**
 * Validate the four text fields. Unknown keys are ignored — in particular
 * anything that tries to name the reporter, the phone or the apartment: those
 * come from the portal session on the server and nowhere else.
 */
export function validatePortalIssueReport(raw: Record<string, unknown>): PortalIssueValidation {
  const parsed = portalIssueReportSchema.safeParse({
    location: raw.location,
    area: raw.area,
    description: raw.description,
    urgency: raw.urgency,
  });
  if (parsed.success) {
    const v = parsed.data;
    return { ok: true, value: { location: v.location, area: v.area || null, description: v.description, urgency: v.urgency } };
  }
  const errors: Partial<Record<PortalIssueField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as PortalIssueField;
    if (!errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}

// ── Photos ────────────────────────────────────────────────────────────────────

export const PORTAL_ISSUE_MAX_IMAGES = 5;

/** Above this the browser refuses the file outright — no attempt to shrink it. */
export const PORTAL_IMAGE_MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** What the server accepts per photo: the issues module's existing cap (5MB)
 *  and types (jpeg/png/webp). The portal does not raise either. */
export const PORTAL_IMAGE_MAX_UPLOAD_BYTES = ISSUE_MAX_IMAGE_SIZE_BYTES;
export const PORTAL_IMAGE_ALLOWED_TYPES = ISSUE_ALLOWED_IMAGE_TYPES;
/** Compression target: longest edge, JPEG quality. */
export const PORTAL_IMAGE_MAX_EDGE = 2000;
export const PORTAL_IMAGE_JPEG_QUALITY = 0.82;

export const PORTAL_IMAGE_MESSAGES = {
  tooLarge: 'הקובץ גדול מדי (עד 8MB)',
  tooMany: `ניתן לצרף עד ${PORTAL_ISSUE_MAX_IMAGES} תמונות`,
  notImage: 'ניתן לצרף תמונות בלבד',
  unreadable: 'לא ניתן לקרוא את התמונה. נסו לצלם שוב או לבחור תמונה אחרת.',
} as const;

export type ImagePrepDecision = 'reject' | 'compress' | 'as_is';

/**
 * What the browser does with a picked photo (decision 03/10/2026):
 *   • over 8MB                                   → reject, never shrink;
 *   • already a jpeg/png/webp, ≤ 5MB and ≤ 2000px → upload as is;
 *   • anything else up to 8MB (bigger, larger, HEIC the browser could decode)
 *                                                → compress: ≤ 2000px JPEG @ 0.82.
 * A compressed file that still exceeds 5MB is rejected by the caller with the
 * same "too large" message. Dimensions are the decoded, upright ones.
 */
export function decideImagePrep(f: { size: number; type: string; width: number; height: number }): ImagePrepDecision {
  if (f.size > PORTAL_IMAGE_MAX_INPUT_BYTES) return 'reject';
  const serverType = PORTAL_IMAGE_ALLOWED_TYPES.includes(f.type);
  const small = f.size <= PORTAL_IMAGE_MAX_UPLOAD_BYTES && Math.max(f.width, f.height) <= PORTAL_IMAGE_MAX_EDGE;
  return serverType && small ? 'as_is' : 'compress';
}

/** The server's gate for one uploaded photo; null = accepted. */
export function portalImageError(file: { size: number; type: string }): 'invalid_file_type' | 'empty_file' | 'file_too_large' | null {
  if (!PORTAL_IMAGE_ALLOWED_TYPES.includes(file.type)) return 'invalid_file_type';
  if (file.size <= 0) return 'empty_file';
  if (file.size > PORTAL_IMAGE_MAX_UPLOAD_BYTES) return 'file_too_large';
  return null;
}
