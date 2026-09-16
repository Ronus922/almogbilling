// Pure decision logic for the Storage garbage collector, shared by the
// read-only auditor (scripts/storage-audit.ts) and the job that actually
// deletes (scripts/storage-cleanup.ts).
//
// Deliberately I/O-free and free of any 'server-only' import so that both a
// bare tsx entrypoint and vitest can load it. It also contains no Storage URL
// or client, which is what keeps scripts/guard-no-storage-leak.sh happy about
// a file under src/ — every byte that talks to Storage lives in the callers.

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

export type Category = 'linked' | 'staged' | 'staged_old' | 'zombie' | 'trash';

/** Only these two are ever deleted. `linked` is live content, `staged` may have
 *  an open compose window behind it, and `trash` is a prefix nothing writes yet. */
export const DELETABLE: readonly Category[] = ['zombie', 'staged_old'] as const;

export const STAGED_MAX_AGE_H = 24;
export const TRASH_PREFIX = '_trash/';

/** A single run may not delete more than this share of one bucket… */
export const SAFETY_MAX_FRACTION = 0.2;
/** …but a sweep this small is always allowed, because on a four-object bucket
 *  every fraction is noise (1 of 4 = 25% would block a legitimate single delete). */
export const SAFETY_MIN_ABSOLUTE = 5;

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
 *   under `_trash/`                      → trash   (already parked for deletion)
 *   no refs                              → zombie  (nothing in the DB knows it)
 *   at least one bound ref               → linked  (live content — never touch)
 *   every ref unbound, all older than
 *   STAGED_MAX_AGE_H                     → staged_old (upload that never got sent)
 *   every ref unbound, some still fresh  → staged  (a compose window may be open)
 *
 * Fail-safe: a ref with a null createdAt can never make a set "all old", so an
 * object with unknown timestamps stays `staged` and is never deleted.
 */
export function classify(
  obj: Pick<StorageObject, 'key'>,
  refs: DbRef[],
  now: Date,
  stagedMaxAgeH = STAGED_MAX_AGE_H,
): Category {
  if (obj.key.startsWith(TRASH_PREFIX)) return 'trash';
  if (refs.length === 0) return 'zombie';
  if (refs.some((r) => r.bound)) return 'linked';
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
 * The second, sharper guard. The fraction brake only approximates the failure
 * it exists for; this names it directly: a bucket that holds objects but for
 * which the DB produced *no pointers at all* means a query returned nothing —
 * a broken join, a renamed column, a table truncated by mistake. Every object
 * then looks like a zombie. Refuse the bucket and let a human look.
 *
 * The cost of the false positive (a bucket that really is entirely garbage)
 * is one manual confirmation; the cost of the false negative is the bucket.
 */
export function dbRefsLookBroken(objectCount: number, refCount: number): boolean {
  return objectCount > 0 && refCount === 0;
}

export type BlockReason = 'safety_fraction' | 'db_refs_missing';

export interface BucketPlan {
  bucket: BillingBucket;
  /** Exact objects to delete — captured up front and never re-derived, so the
   *  delete call can only ever touch keys that were inspected (iron rule 12). */
  toDelete: ClassifiedObject[];
  objectCount: number;
  refCount: number;
  bytes: number;
  blocked: BlockReason | null;
}

/**
 * Turns one bucket's classified inventory into a delete list, or blocks it.
 * A blocked bucket reports an empty `toDelete` so a caller that ignores
 * `blocked` still cannot delete anything.
 */
export function planBucket(
  bucket: BillingBucket,
  objects: ClassifiedObject[],
  refCount: number,
  opts: { maxFraction?: number; minAbsolute?: number } = {},
): BucketPlan {
  const candidates = objects.filter((o) => DELETABLE.includes(o.category));
  const base = {
    bucket,
    objectCount: objects.length,
    refCount,
    bytes: candidates.reduce((s, o) => s + o.sizeBytes, 0),
  };

  if (dbRefsLookBroken(objects.length, refCount)) {
    return { ...base, toDelete: [], bytes: 0, blocked: 'db_refs_missing' };
  }
  if (exceedsSafetyLimit(candidates.length, objects.length, opts.maxFraction, opts.minAbsolute)) {
    return { ...base, toDelete: [], bytes: 0, blocked: 'safety_fraction' };
  }
  return { ...base, toDelete: candidates, blocked: null };
}

/** `/api/public/wa-media/<a>/<b>` (possibly absolute, possibly percent-encoded)
 *  → the Storage key `a/b`. Returns null for anything else. */
export function waMediaKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  const marker = '/api/public/wa-media/';
  const i = url.indexOf(marker);
  if (i === -1) return null;
  const raw = url.slice(i + marker.length).split('?')[0];
  if (!raw) return null;
  return raw
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
