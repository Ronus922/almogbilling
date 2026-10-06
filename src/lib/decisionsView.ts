import type { DecisionRow } from '@/lib/db/portalDecisions';
import { buildProxyUrl } from '@/lib/storage/server';
import type { DecisionType } from '@/lib/decisions';

// The two shapes a decision row leaves the server in. They differ by exactly
// one thing — what the reader is allowed to know — and that is the point of
// having two:
//
//   DecisionAdminView  (/api/decisions)        — the CRM: adds `published`,
//     the file's size and name, and the staff file URL (/api/files, re-checked
//     per request against portal_decisions:view).
//   DecisionPortalView (/api/portal/decisions) — the owner: no object key, no
//     bucket, no uploader, no `published` flag (every row it carries IS
//     published), and no /api/files URL — the portal's own route streams it.

export interface DecisionAdminView {
  id: string;
  title: string;
  summary: string | null;
  doc_type: DecisionType;
  decision_number: string | null;
  decided_at: string;
  original_filename: string;
  file_size: number;
  published: boolean;
  /** Staff-only, permission-checked (relative by construction). */
  file_url: string;
  created_at: string;
}

export interface DecisionPortalView {
  id: string;
  title: string;
  summary: string | null;
  doc_type: DecisionType;
  decision_number: string | null;
  decided_at: string;
  file_size: number;
}

export function toDecisionAdminView(r: DecisionRow): DecisionAdminView {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    doc_type: r.doc_type,
    decision_number: r.decision_number,
    decided_at: r.decided_at,
    original_filename: r.original_filename,
    file_size: r.file_size,
    published: r.published,
    file_url: buildProxyUrl('portal-decisions', r.object_key),
    created_at: new Date(r.created_at).toISOString(),
  };
}

export function toDecisionPortalView(r: DecisionRow): DecisionPortalView {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    doc_type: r.doc_type,
    decision_number: r.decision_number,
    decided_at: r.decided_at,
    file_size: r.file_size,
  };
}
