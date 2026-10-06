import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { DecisionType } from '@/lib/decisions';

// Decisions & protocols (public.portal_decisions). Two readers with two
// different rights, and the difference is in the SQL, never in a caller:
//   • listDecisions()        — the CRM: every row, published or not;
//   • listPublishedDecisions() / findPublishedDecision() — the portal: the
//     `published` predicate is inside the query, so no portal code path can
//     forget it (the same discipline as finance/portal.ts).

export interface DecisionRow {
  id: string;
  title: string;
  summary: string | null;
  doc_type: DecisionType;
  decision_number: string | null;
  decided_at: string;
  bucket: string;
  object_key: string;
  original_filename: string;
  file_size: number;
  mime_type: string;
  published: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// decided_at is a DATE: pg hands it back as a Date in the server's zone, which
// would shift the calendar day. ::text keeps the stored day exactly.
const COLS = `
  id, title, summary, doc_type, decision_number, decided_at::text as decided_at,
  bucket, object_key, original_filename, file_size::int as file_size, mime_type,
  published, created_by, created_at, updated_at`;

/** The CRM list: everything, newest decision first, hidden rows included. */
export async function listDecisions(): Promise<DecisionRow[]> {
  const r = await query<DecisionRow>(
    `select ${COLS} from public.portal_decisions order by decided_at desc, created_at desc`,
  );
  return r.rows;
}

export async function findDecision(id: string): Promise<DecisionRow | null> {
  return queryOne<DecisionRow>(`select ${COLS} from public.portal_decisions where id = $1`, [id]);
}

/** The portal list — published only, the predicate is in the SQL. */
export async function listPublishedDecisions(): Promise<DecisionRow[]> {
  const r = await query<DecisionRow>(
    `select ${COLS} from public.portal_decisions
      where published = true
      order by decided_at desc, created_at desc`,
  );
  return r.rows;
}

/** One published row — what the portal's file route streams. An unpublished id
 *  returns null here, which the route turns into the same 404 a missing id
 *  gets: unpublishing closes the file path in the same instant it closes the
 *  list. */
export async function findPublishedDecision(id: string): Promise<DecisionRow | null> {
  return queryOne<DecisionRow>(
    `select ${COLS} from public.portal_decisions where id = $1 and published = true`,
    [id],
  );
}

export async function insertDecision(input: {
  title: string;
  summary: string | null;
  docType: DecisionType;
  decisionNumber: string | null;
  decidedAt: string;
  objectKey: string;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  published: boolean;
  createdBy: string;
}): Promise<DecisionRow> {
  const r = await query<DecisionRow>(
    `insert into public.portal_decisions
       (title, summary, doc_type, decision_number, decided_at, object_key,
        original_filename, file_size, mime_type, published, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning ${COLS}`,
    [
      input.title, input.summary, input.docType, input.decisionNumber, input.decidedAt,
      input.objectKey, input.originalFilename, input.fileSize, input.mimeType,
      input.published, input.createdBy,
    ],
  );
  return r.rows[0];
}

/**
 * Metadata only — the file is never replaced (replacing = delete + upload
 * again, the product rule). `published` rides along because the list's switch
 * is the same update; every field is required by the caller, so a PATCH cannot
 * blank a column by omitting it.
 */
export async function updateDecision(id: string, input: {
  title: string;
  summary: string | null;
  docType: DecisionType;
  decisionNumber: string | null;
  decidedAt: string;
  published: boolean;
}): Promise<DecisionRow | null> {
  return queryOne<DecisionRow>(
    `update public.portal_decisions
        set title = $2, summary = $3, doc_type = $4, decision_number = $5,
            decided_at = $6, published = $7, updated_at = now()
      where id = $1
      returning ${COLS}`,
    [id, input.title, input.summary, input.docType, input.decisionNumber, input.decidedAt, input.published],
  );
}

/** The published switch of the list row — one column, nothing else touched. */
export async function setDecisionPublished(id: string, published: boolean): Promise<DecisionRow | null> {
  return queryOne<DecisionRow>(
    `update public.portal_decisions set published = $2, updated_at = now()
      where id = $1 returning ${COLS}`,
    [id, published],
  );
}

/** Deletes the row and hands back what it pointed at, so the caller can remove
 *  the object. Returns null when the id was already gone. */
export async function deleteDecision(id: string): Promise<DecisionRow | null> {
  return queryOne<DecisionRow>(
    `delete from public.portal_decisions where id = $1 returning ${COLS}`,
    [id],
  );
}
