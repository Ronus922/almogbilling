import 'server-only';
import { query, queryOne } from '@/lib/db';
import { buildProxyUrl, VISITOR_IDS_BUCKET } from '@/lib/storage/server';
import {
  VISITOR_EDITABLE_FIELDS,
  VISITOR_PAGE_SIZE,
  phoneNeedle,
  type DocumentType,
  type VisitorEditableField,
  type VisitorScan,
} from '@/lib/visitors/model';
import type { VisitorCreateInput } from '@/lib/validation/visitors';

// The visitor_scans table ("סריקת כניסה"). The photo's object key never leaves
// the server: a row goes out with image_url, a same-origin /api/files path that
// re-checks the session and the role on every request.

interface ScanRow {
  id: string;
  document_type: DocumentType;
  document_number: string;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  nationality: string | null;
  phone: string | null;
  room_number: string | null;
  chip_number: string | null;
  notes: string | null;
  image_object_key: string;
  image_original_name: string | null;
  scanned_by: string | null;
  scanned_by_name: string | null;
  created_at: string;
  updated_at: string;
}

function toScan(r: ScanRow): VisitorScan {
  return {
    id: r.id,
    document_type: r.document_type,
    document_number: r.document_number,
    first_name: r.first_name,
    last_name: r.last_name,
    date_of_birth: r.date_of_birth,
    nationality: r.nationality,
    phone: r.phone,
    room_number: r.room_number,
    chip_number: r.chip_number,
    notes: r.notes,
    image_url: buildProxyUrl(VISITOR_IDS_BUCKET, r.image_object_key),
    image_original_name: r.image_original_name,
    scanned_by: r.scanned_by,
    scanned_by_name: r.scanned_by_name,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Escapes LIKE wildcards so the typed text is matched literally. */
function likeNeedle(q: string): string {
  return q.toLocaleLowerCase('he-IL').replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface VisitorListFilter {
  /** Free text: a first / last name (either order) or part of a phone number. */
  q: string;
  /** Scan day range, inclusive, `YYYY-MM-DD` in Israel time; null = open. */
  from: string | null;
  to: string | null;
  page: number;
}

export async function listVisitorScans(f: VisitorListFilter): Promise<{ rows: VisitorScan[]; total: number }> {
  const q = f.q.trim();
  const nameNeedle = q === '' ? '' : likeNeedle(q);
  const digits = phoneNeedle(q);
  const offset = (Math.max(1, f.page) - 1) * VISITOR_PAGE_SIZE;
  const r = await query<ScanRow & { total: number }>(
    `select id, document_type, document_number, first_name, last_name,
            to_char(date_of_birth, 'YYYY-MM-DD') as date_of_birth,
            nationality, phone, room_number, chip_number, notes,
            image_object_key, image_original_name, scanned_by, scanned_by_name,
            created_at, updated_at,
            count(*) over ()::int as total
       from public.visitor_scans
      where (
              $1::text = ''
              or lower(first_name || ' ' || last_name) like '%' || $1 || '%'
              or lower(last_name || ' ' || first_name) like '%' || $1 || '%'
              or ($2::text <> ''
                  and regexp_replace(coalesce(phone, ''), '\\D', '', 'g') like '%' || $2 || '%')
            )
        and ($3::date is null or created_at >= $3::date::timestamp at time zone 'Asia/Jerusalem')
        and ($4::date is null or created_at < ($4::date + 1)::timestamp at time zone 'Asia/Jerusalem')
      order by created_at desc, id desc
      limit $5 offset $6`,
    [nameNeedle, digits, f.from, f.to, VISITOR_PAGE_SIZE, offset],
  );
  return { rows: r.rows.map(toScan), total: r.rows[0]?.total ?? 0 };
}

export async function getVisitorScan(id: string): Promise<VisitorScan | null> {
  const r = await queryOne<ScanRow>(
    `select id, document_type, document_number, first_name, last_name,
            to_char(date_of_birth, 'YYYY-MM-DD') as date_of_birth,
            nationality, phone, room_number, chip_number, notes,
            image_object_key, image_original_name, scanned_by, scanned_by_name,
            created_at, updated_at
       from public.visitor_scans
      where id = $1`,
    [id],
  );
  return r ? toScan(r) : null;
}

/**
 * The same person scanned again by the same user within a few minutes — the signature of a
 * "שמור" pressed twice after the network dropped on the first. Returns that row's id, or null.
 */
export async function findRecentDuplicate(
  scannedBy: string,
  v: { document_type: string; document_number: string; first_name: string; last_name: string },
): Promise<string | null> {
  const r = await queryOne<{ id: string }>(
    `select id
       from public.visitor_scans
      where scanned_by = $1
        and document_type = $2
        and document_number = $3
        and first_name = $4
        and last_name = $5
        and created_at > now() - interval '3 minutes'
      order by created_at desc
      limit 1`,
    [scannedBy, v.document_type, v.document_number, v.first_name, v.last_name],
  );
  return r?.id ?? null;
}

export interface NewVisitorScan extends VisitorCreateInput {
  image_object_key: string;
  /** Final weight of the stored photo, in bytes. */
  image_bytes: number;
  image_original_name: string | null;
  scanned_by: string;
}

export async function insertVisitorScan(v: NewVisitorScan): Promise<string> {
  const r = await query<{ id: string }>(
    `insert into public.visitor_scans
       (document_type, document_number, first_name, last_name, date_of_birth, nationality,
        phone, room_number, chip_number, notes, image_object_key, image_original_name,
        scanned_by, scanned_by_name, image_bytes)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13,
             (select coalesce(u.full_name, u.username) from public.users u where u.id = $13), $14)
     returning id`,
    [
      v.document_type, v.document_number, v.first_name, v.last_name, v.date_of_birth, v.nationality,
      v.phone, v.room_number, v.chip_number, v.notes, v.image_object_key, v.image_original_name, v.scanned_by,
      v.image_bytes,
    ],
  );
  return r.rows[0]!.id;
}

/**
 * Changes the given columns of one row. `patch` keys are already restricted to
 * VisitorEditableField by the caller's schema; the whitelist below is the second
 * lock, so a column name can never come from the request. Returns the fresh row,
 * or null when the id does not exist.
 */
export async function updateVisitorScan(
  id: string,
  patch: Partial<Record<VisitorEditableField, string | null>>,
): Promise<VisitorScan | null> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const key of VISITOR_EDITABLE_FIELDS) {
    if (!(key in patch)) continue;
    vals.push(patch[key] ?? null);
    cols.push(key === 'date_of_birth' ? `${key} = $${vals.length}::date` : `${key} = $${vals.length}`);
  }
  if (cols.length === 0) return getVisitorScan(id);
  vals.push(id);
  const r = await query(
    `update public.visitor_scans set ${cols.join(', ')}, updated_at = now() where id = $${vals.length}`,
    vals,
  );
  if (r.rowCount === 0) return null;
  return getVisitorScan(id);
}

/** Deletes a row and returns its photo's object key (to remove from Storage), or null if absent. */
export async function deleteVisitorScan(id: string): Promise<string | null> {
  const r = await queryOne<{ image_object_key: string }>(
    `delete from public.visitor_scans where id = $1 returning image_object_key`,
    [id],
  );
  return r?.image_object_key ?? null;
}

export type ReplaceImageResult =
  | { kind: 'replaced'; oldKey: string }
  /** The row exists but its photo is no longer the one the caller cropped (someone replaced it meanwhile). */
  | { kind: 'stale' }
  | { kind: 'gone' };

/**
 * Points a row at a new photo — but only if it still points at `expectedOldKey`, the photo the
 * admin actually cropped. The row is locked first, so two re-crops of the same row run one after
 * the other: the second sees the first's key, no longer matches, and is `stale` instead of
 * overwriting (and deleting) a newer photo. `replaced` carries the OLD key, to remove from Storage.
 */
export async function replaceVisitorImage(
  id: string,
  newObjectKey: string,
  newBytes: number,
  expectedOldKey: string,
): Promise<ReplaceImageResult> {
  const r = await queryOne<{ replaced: string | null; current: string | null }>(
    `with old as (select image_object_key from public.visitor_scans where id = $1 for update),
          upd as (
            update public.visitor_scans s
               set image_object_key = $2, image_bytes = $3, updated_at = now()
              from old
             where s.id = $1 and old.image_object_key = $4
            returning old.image_object_key as old_key)
     select (select old_key from upd) as replaced, (select image_object_key from old) as current`,
    [id, newObjectKey, newBytes, expectedOldKey],
  );
  if (!r || r.current === null) return { kind: 'gone' };
  return r.replaced ? { kind: 'replaced', oldKey: r.replaced } : { kind: 'stale' };
}
