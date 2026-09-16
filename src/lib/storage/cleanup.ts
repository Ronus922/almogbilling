// Pure decision logic for the Storage garbage collector, shared by the
// read-only auditor (scripts/storage-audit.ts) and the job that actually
// deletes (scripts/storage-cleanup.ts).
//
// Deliberately I/O-free and free of any 'server-only' import so that both a
// bare tsx entrypoint and vitest can load it. It also contains no Storage URL
// or client, which is what keeps scripts/guard-no-storage-leak.sh happy about
// a file under src/ — every byte that talks to Storage lives in the callers.
//
// ⚠️  Storage object bytes are in NO backup. scripts/backup/* dumps Postgres and
//     pushes only /var/backups/supabase/daily to restic; the Storage volume is
//     not in it. Every deletion here is irreversible, which is why the default
//     is a dry run and why the brakes below prefer a false block to a false
//     delete.

/** Every bucket billing owns. Other buckets on the same Storage instance
 *  (invoice-files, maintenance-media, …) belong to other projects — never touched. */
export const BILLING_BUCKETS = [
  'documents',
  'issue-attachments',
  'supplier-documents',
  'whatsapp-attachments',
  'whatsapp-media',
] as const;
export type BillingBucket = (typeof BILLING_BUCKETS)[number];

export function isBillingBucket(v: string | null | undefined): v is BillingBucket {
  return v != null && (BILLING_BUCKETS as readonly string[]).includes(v);
}

export type Category = 'linked' | 'staged' | 'staged_old' | 'zombie' | 'zombie_fresh' | 'trash';

/** Only these two are ever deleted. `linked` is live content, `staged` may have
 *  an open compose window behind it, `zombie_fresh` is too young to trust, and
 *  `trash` is a prefix nothing writes yet. */
export const DELETABLE: readonly Category[] = ['zombie', 'staged_old'] as const;

/** An unbound attachment row older than this is an upload that was never sent. */
export const STAGED_MAX_AGE_H = 24;
/**
 * An object with no DB pointer at all must be at least this old before it can be
 * called garbage. Every upload path in this codebase writes the OBJECT first and
 * its DB row a moment later (uploadObject → insert), so a file that is seconds
 * old and has no row is far more likely to be an in-flight upload than garbage.
 * Without this floor a GC run racing a user's upload would delete their file.
 */
export const ZOMBIE_MIN_AGE_H = 24;

export const TRASH_PREFIX = '_trash/';

/** A single run may not delete more than this share of one bucket… */
export const SAFETY_MAX_FRACTION = 0.2;
/**
 * …and at most this many objects may bypass that share. Deliberately 1: the real
 * buckets are tiny (4–43 objects), so on a 4-object bucket a single legitimate
 * delete is 25% and would be blocked. One object is the smallest exemption that
 * unblocks that case, and it caps the blast radius of the exemption at exactly
 * one object per bucket per run.
 */
export const SAFETY_MIN_ABSOLUTE = 1;

export interface StorageObject {
  bucket: BillingBucket;
  key: string;
  sizeBytes: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface DbRef {
  /** object key as Storage stores it */
  key: string;
  table: string;
  column: string;
  rowId: string;
  /** false for an attachment row not yet bound to a message / campaign */
  bound: boolean;
  createdAt: Date | null;
}

export interface ClassifiedObject extends StorageObject {
  category: Category;
  refs: DbRef[];
}

export interface OrphanRow extends DbRef {
  bucket: string;
}

/**
 * Decides what a single Storage object is, given every DB row that points at it.
 *
 *   under `_trash/`                   → trash        (already parked for deletion)
 *   at least one bound ref            → linked       (live content — never touch)
 *   no refs, younger than
 *   ZOMBIE_MIN_AGE_H, or age unknown  → zombie_fresh (may be an in-flight upload)
 *   no refs, older than that          → zombie       (nothing in the DB knows it)
 *   every ref unbound, all older than
 *   STAGED_MAX_AGE_H                  → staged_old   (upload that never got sent)
 *   every ref unbound, some fresh     → staged       (a compose window may be open)
 *
 * Fail-safe throughout: a null timestamp never qualifies an object for deletion.
 */
export function classify(
  obj: Pick<StorageObject, 'key' | 'createdAt'>,
  refs: DbRef[],
  now: Date,
  stagedMaxAgeH = STAGED_MAX_AGE_H,
  zombieMinAgeH = ZOMBIE_MIN_AGE_H,
): Category {
  if (obj.key.startsWith(TRASH_PREFIX)) return 'trash';
  if (refs.some((r) => r.bound)) return 'linked';

  if (refs.length === 0) {
    const created = obj.createdAt;
    if (created == null) return 'zombie_fresh';
    return created.getTime() < now.getTime() - zombieMinAgeH * 3600_000 ? 'zombie' : 'zombie_fresh';
  }

  const cutoff = now.getTime() - stagedMaxAgeH * 3600_000;
  const allOld = refs.every((r) => r.createdAt != null && r.createdAt.getTime() < cutoff);
  return allOld ? 'staged_old' : 'staged';
}

/**
 * The circuit breaker: a single run may never touch more than `maxFraction` of a
 * bucket's objects. A cross-reference bug (an empty table, a renamed column)
 * shows up exactly like "almost everything is a zombie", so the run must stop
 * instead of deleting real content.
 *
 * An empty bucket is never a breach (0 of 0), and a sweep of at most
 * `minAbsolute` objects is never a breach either — see SAFETY_MIN_ABSOLUTE.
 */
export function exceedsSafetyLimit(
  toTouch: number,
  bucketTotal: number,
  maxFraction = SAFETY_MAX_FRACTION,
  minAbsolute = SAFETY_MIN_ABSOLUTE,
): boolean {
  if (bucketTotal === 0) return false;
  if (toTouch <= minAbsolute) return false;
  return toTouch / bucketTotal > maxFraction;
}

/**
 * Second guard. The fraction brake only approximates the failure it exists for;
 * this names it: a bucket that holds objects but for which the DB produced *no
 * pointers at all* means a query returned nothing — a broken join, a renamed
 * column, a table truncated by mistake. Every object then looks like a zombie.
 */
export function dbRefsLookBroken(objectCount: number, refCount: number): boolean {
  return objectCount > 0 && refCount === 0;
}

/**
 * Third guard, for the case the second one misses: the DB returned plenty of
 * pointers but NOT ONE of them matches an object that is actually in the bucket.
 * That is what a key-format change looks like (a column that starts storing
 * `bucket/key` instead of `key`, say) — refCount is healthy, so
 * dbRefsLookBroken stays quiet, yet every object has become a zombie.
 */
export function refsMatchedNothing(objectCount: number, refCount: number, matchedRefs: number): boolean {
  return objectCount > 0 && refCount > 0 && matchedRefs === 0;
}

export type BlockReason = 'safety_fraction' | 'db_refs_missing' | 'db_refs_matched_nothing' | 'unknown_bucket_values';

export interface BucketPlan {
  bucket: BillingBucket;
  /** Everything the classifier selected. Populated even when the bucket is
   *  blocked — a dry run exists to show what WOULD have gone, and a blocked
   *  bucket is precisely the case someone needs to inspect. */
  candidates: ClassifiedObject[];
  /** What will actually be deleted: `candidates`, or nothing if blocked. This is
   *  captured once and is the only list handed to remove() (iron rule 12). */
  toDelete: ClassifiedObject[];
  objectCount: number;
  refCount: number;
  matchedRefs: number;
  bytes: number;
  blocked: BlockReason | null;
}

export interface PlanInput {
  objects: ClassifiedObject[];
  /** every DB pointer collected for this bucket, matching or not */
  refCount: number;
  /** how many of those actually correspond to an object present in the bucket */
  matchedRefs: number;
  /** true when a DB row named a bucket outside BILLING_BUCKETS — a pointer we
   *  cannot account for, so no bucket may be swept on this run */
  sawUnknownBucketValues?: boolean;
}

/**
 * Turns one bucket's classified inventory into a delete list, or blocks it.
 * A blocked bucket reports an EMPTY `toDelete` (while keeping `candidates`), so
 * a caller that ignores `blocked` still cannot delete anything.
 */
export function planBucket(
  bucket: BillingBucket,
  input: PlanInput,
  opts: { maxFraction?: number; minAbsolute?: number } = {},
): BucketPlan {
  const { objects, refCount, matchedRefs, sawUnknownBucketValues = false } = input;
  const candidates = objects.filter((o) => DELETABLE.includes(o.category));
  const base = {
    bucket,
    candidates,
    objectCount: objects.length,
    refCount,
    matchedRefs,
    bytes: candidates.reduce((s, o) => s + o.sizeBytes, 0),
  };

  const blocked: BlockReason | null = sawUnknownBucketValues
    ? 'unknown_bucket_values'
    : dbRefsLookBroken(objects.length, refCount)
      ? 'db_refs_missing'
      : refsMatchedNothing(objects.length, refCount, matchedRefs)
        ? 'db_refs_matched_nothing'
        : exceedsSafetyLimit(candidates.length, objects.length, opts.maxFraction, opts.minAbsolute)
          ? 'safety_fraction'
          : null;

  return blocked ? { ...base, toDelete: [], blocked } : { ...base, toDelete: candidates, blocked: null };
}

/** The only tables a `staged_old` ref can come from: `bound: false` is produced
 *  nowhere else (scripts/storage-audit.ts collectDbRefs is the authority). */
export const STAGED_REF_TABLES = ['wa_campaign_attachments', 'wa_message_attachments'] as const;
export type StagedRefTable = (typeof STAGED_REF_TABLES)[number];

export function isStagedRefTable(v: string): v is StagedRefTable {
  return (STAGED_REF_TABLES as readonly string[]).includes(v);
}

/**
 * Which attachment rows must have `object_deleted_at` stamped after their
 * objects were removed, grouped by table and de-duplicated.
 *
 * The row is marked, never deleted: the GC does not remove DB data, and the row
 * is the last record that the upload ever happened (name, size, who, when).
 * Marking is what keeps a compose sheet that has been open past the staging
 * window from submitting a file whose bytes are gone.
 *
 * Only `staged_old` contributes — a `zombie` has no row by definition, and the
 * caller must pass only objects the Storage server CONFIRMED it removed, since
 * a stamp on an object that still exists would block a live file.
 *
 * Throws on a ref from any other table: that means the ref collection changed
 * under us, which is a reason to stop rather than to guess which row to touch.
 */
export function rowsToMarkDeleted(removed: ClassifiedObject[]): Map<StagedRefTable, string[]> {
  const byTable = new Map<StagedRefTable, Set<string>>();
  for (const obj of removed) {
    if (obj.category !== 'staged_old') continue;
    for (const ref of obj.refs) {
      if (!isStagedRefTable(ref.table)) {
        throw new Error(`staged_old ref from unexpected table ${ref.table} (row ${ref.rowId})`);
      }
      const set = byTable.get(ref.table);
      if (set) set.add(ref.rowId);
      else byTable.set(ref.table, new Set([ref.rowId]));
    }
  }
  return new Map([...byTable].map(([table, ids]) => [table, [...ids]]));
}

/** `/api/public/wa-media/<a>/<b>` or `/api/files/<bucket>/<a>/<b>` (possibly
 *  absolute, possibly percent-encoded) → `{ bucket, key }`. Null for anything
 *  else, including Green API's own CDN, which we do not own.
 *
 *  Both shapes matter: chat_messages.media_url holds the public wa-media proxy
 *  for outbound media AND the authenticated /api/files proxy for a message
 *  attachment, and both are live pointers into a billing bucket. */
export function storageRefFromUrl(url: string | null): { bucket: BillingBucket; key: string } | null {
  if (!url) return null;

  const pub = '/api/public/wa-media/';
  const iPub = url.indexOf(pub);
  if (iPub !== -1) {
    const key = decodePath(url.slice(iPub + pub.length));
    return key ? { bucket: 'whatsapp-media', key } : null;
  }

  const files = '/api/files/';
  const iFiles = url.indexOf(files);
  if (iFiles !== -1) {
    const rest = url.slice(iFiles + files.length).split('?')[0];
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const bucket = decodeURIComponent(rest.slice(0, slash));
    if (!isBillingBucket(bucket)) return null;
    const key = decodePath(rest.slice(slash + 1));
    return key ? { bucket, key } : null;
  }

  return null;
}

function decodePath(raw: string): string | null {
  const trimmed = raw.split('?')[0];
  if (!trimmed) return null;
  return trimmed
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

/** Back-compat shim for the wa-media shape alone. */
export function waMediaKeyFromUrl(url: string | null): string | null {
  const r = storageRefFromUrl(url);
  return r && r.bucket === 'whatsapp-media' ? r.key : null;
}

/** Classifies one bucket's objects against the refs collected for it, and
 *  reports how many of those refs actually matched something present. */
export function classifyBucket(
  bucket: BillingBucket,
  objects: StorageObject[],
  refs: DbRef[],
  now: Date,
): { objects: ClassifiedObject[]; orphanRows: OrphanRow[]; matchedRefs: number } {
  const refsByKey = new Map<string, DbRef[]>();
  for (const r of refs) {
    const list = refsByKey.get(r.key);
    if (list) list.push(r);
    else refsByKey.set(r.key, [r]);
  }
  const present = new Set(objects.map((o) => o.key));

  const classified = objects.map((o) => {
    const objRefs = refsByKey.get(o.key) ?? [];
    return { ...o, refs: objRefs, category: classify(o, objRefs, now) };
  });

  const orphanRows: OrphanRow[] = refs.filter((r) => !present.has(r.key)).map((r) => ({ ...r, bucket }));
  return { objects: classified, orphanRows, matchedRefs: refs.length - orphanRows.length };
}
