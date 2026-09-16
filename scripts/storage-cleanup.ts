// scripts/storage-cleanup.ts — the Storage garbage collector.
//
//   npm run storage:cleanup              # DRY RUN (default): resolve, record, delete nothing
//   npm run storage:cleanup -- --apply   # actually remove the resolved objects
//   npm run storage:cleanup -- --json    # machine-readable plan
//
// Deletes exactly two categories (see src/lib/storage/cleanup.ts):
//   zombie      no DB row anywhere points at it
//   staged_old  an attachment row never bound to a message/campaign, now >24h old
// `linked` is live content and `staged` may have an open compose window behind
// it — neither is ever touched.
//
// A `staged_old` delete also STAMPS the row that pointed at the object with
// wa_*_attachments.object_deleted_at. The row is never deleted — this job does
// not remove DB data — but the staged lookups skip a stamped row, so a compose
// sheet left open past the staging window is refused instead of sending a file
// whose bytes are gone. Stamping happens only AFTER the Storage server confirms
// the removal: a stamp for an object that still exists would block a live file.
//
// Every run writes a row to public.storage_cleanup_runs, dry runs included.
//
// SAFETY
//   * Dry run is the default. Deleting requires an explicit --apply.
//   * Two independent brakes, per bucket (src/lib/storage/cleanup.ts):
//       - more than 20% of the bucket selected  → bucket blocked
//         (a sweep of ≤5 objects is exempt: on a 4-object bucket every
//         fraction is noise)
//       - the bucket has objects but the DB produced ZERO pointers for it
//         → bucket blocked. That is what a broken join or a renamed column
//         looks like, and it makes every object look like a zombie.
//   * The exact (bucket, key) list is resolved ONCE, written to the run row,
//     and is the only thing the delete call is given — never a filter, never a
//     prefix (CLAUDE.md iron rule 12).
//   * BILLING_BUCKETS is an allowlist. Other projects share this Storage
//     instance (invoice-files, maintenance-media, …) and are never enumerated.
//
// Reads DATABASE_URL / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from
// the environment (systemd EnvironmentFile) or .env.local.
import dotenv from 'dotenv';
import { Client } from 'pg';
import { StorageClient } from '@supabase/storage-js';
import {
  BILLING_BUCKETS,
  planBucket,
  rowsToMarkDeleted,
  type BillingBucket,
  type BucketPlan,
  type ClassifiedObject,
  type StorageObject,
} from '../src/lib/storage/cleanup';
import { auditListed, collectDbRefs, listBucket, storageClient } from './storage-audit';

dotenv.config({ path: '.env.local', quiet: true });

type Stage = 'connect' | 'list' | 'cross_reference' | 'delete' | 'record';

class StageError extends Error {
  constructor(readonly stage: Stage, message: string) {
    super(message);
  }
}

interface PlanEntry {
  bucket: BillingBucket;
  objectCount: number;
  refCount: number;
  candidates: number;
  bytes: number;
  matchedRefs: number;
  blocked: string | null;
  /** Every key the classifier selected — recorded even when the bucket is
   *  blocked, because a blocked bucket is exactly the one someone needs to
   *  inspect. When `blocked` is null this is also the delete list. */
  keys: { key: string; category: string; sizeBytes: number; createdAt: string | null }[];
}

function toEntry(p: BucketPlan): PlanEntry {
  return {
    bucket: p.bucket,
    objectCount: p.objectCount,
    refCount: p.refCount,
    candidates: p.candidates.length,
    bytes: p.bytes,
    matchedRefs: p.matchedRefs,
    blocked: p.blocked,
    keys: p.candidates.map((o) => ({
      key: o.key,
      category: o.category,
      sizeBytes: o.sizeBytes,
      createdAt: o.createdAt?.toISOString() ?? null,
    })),
  };
}

/** Remove one explicit list of keys and return the keys the SERVER reports it
 *  removed. Unlike the app's deleteObjects(), this surfaces the error instead of
 *  swallowing it, and it never counts an object the server did not confirm — the
 *  run row must not claim a deletion that did not happen. */
async function removeKeys(sc: StorageClient, bucket: string, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const { data, error } = await sc.from(bucket).remove(keys);
  if (error) throw new StageError('delete', `remove ${bucket} (${keys.length} keys): ${error.message}`);
  return (data ?? []).map((o) => o.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Applies the decision from rowsToMarkDeleted(): stamp the rows that pointed at
 * the objects just removed. Addressed by the exact row ids resolved during
 * planning — never by a filter over the table (CLAUDE.md iron rule 12) — and
 * idempotent (`object_deleted_at is null`).
 */
async function markRowsObjectDeleted(db: Client, removedObjects: ClassifiedObject[]): Promise<number> {
  let marked = 0;
  for (const [table, ids] of rowsToMarkDeleted(removedObjects)) {
    // The table comes from a two-value union, never interpolated from data.
    const r =
      table === 'wa_campaign_attachments'
        ? await db.query(
            `update public.wa_campaign_attachments set object_deleted_at = now()
              where id = any($1::uuid[]) and object_deleted_at is null`,
            [ids],
          )
        : await db.query(
            `update public.wa_message_attachments set object_deleted_at = now()
              where id = any($1::uuid[]) and object_deleted_at is null`,
            [ids],
          );
    marked += r.rowCount ?? 0;
  }
  return marked;
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const asJson = args.includes('--json');
  const mode = apply ? 'apply' : 'dry_run';

  const url = process.env.DATABASE_URL;
  if (!url) throw new StageError('connect', 'DATABASE_URL not set');

  const db = new Client({ connectionString: url });
  await db.connect();

  // Close out rows abandoned by a previous run that was killed (SIGKILL, the
  // systemd TimeoutStartSec, a pooler drop) — otherwise they sit at 'running'
  // forever and poison exactly the dry-run record the arming decision rests on.
  // Scoped to this job's own table, to 'running' only, and to rows older than
  // 6h — far beyond the 30min unit timeout, so a concurrent run is never hit.
  const abandoned = await db.query(
    `update public.storage_cleanup_runs
        set status = 'error', error_stage = 'record', finished_at = now(),
            error_message = 'abandoned: no completion recorded; closed out by a later run'
      where status = 'running' and started_at < now() - interval '6 hours'`,
  );
  if (abandoned.rowCount) console.error(`[storage-cleanup] closed ${abandoned.rowCount} abandoned run(s)`);

  const runId = (
    await db.query<{ id: string }>(
      `insert into public.storage_cleanup_runs (mode) values ($1) returning id`,
      [mode],
    )
  ).rows[0].id;

  let stage: Stage = 'connect';
  try {
    const sc = storageClient();
    const now = new Date();

    // ORDER MATTERS. Storage is listed FIRST and the DB read SECOND, so a row
    // committed while the run is in flight is still seen. The reverse order
    // (refs first) would let an upload that lands between the two reads look
    // like an object nothing references. Combined with ZOMBIE_MIN_AGE_H that
    // closes the race in both directions.
    stage = 'list';
    const listed = new Map<BillingBucket, StorageObject[]>();
    for (const bucket of BILLING_BUCKETS) listed.set(bucket, await listBucket(sc, bucket));

    stage = 'cross_reference';
    const { byBucket: refsByBucket, unknownBucketValues } = await collectDbRefs(db);

    const plans: BucketPlan[] = BILLING_BUCKETS.map((bucket) => {
      const objects = listed.get(bucket) ?? [];
      const audit = auditListed(bucket, objects, refsByBucket, now);
      return planBucket(bucket, {
        objects: audit.objects,
        refCount: (refsByBucket.get(bucket) ?? []).length,
        matchedRefs: audit.matchedRefs,
        sawUnknownBucketValues: unknownBucketValues.length > 0,
      });
    });

    const entries = plans.map(toEntry);
    const scanned = plans.reduce((s, p) => s + p.objectCount, 0);
    const blocked = plans.filter((p) => p.blocked !== null).length;
    const plannedBytes = plans.reduce((s, p) => s + p.bytes, 0);
    const plannedCount = plans.reduce((s, p) => s + p.toDelete.length, 0);

    // The plan is frozen AND PERSISTED here, before a single object is removed.
    // If the run dies mid-delete, the row still names every key that was in
    // scope — without this the forensic trail would be exactly the thing the
    // failure destroyed.
    stage = 'record';
    await db.query(
      `update public.storage_cleanup_runs
          set objects_scanned = $2, buckets_blocked = $3, summary = $4::jsonb
        where id = $1`,
      [runId, scanned, blocked, JSON.stringify({ mode, unknownBucketValues, plannedCount, plannedBytes, buckets: entries })],
    );

    stage = 'delete';
    let deleted = 0;
    let deletedBytes = 0;
    let rowsMarked = 0;
    if (apply) {
      for (const p of plans) {
        if (p.blocked !== null || p.toDelete.length === 0) continue;
        const bySize = new Map(p.toDelete.map((o) => [o.key, o.sizeBytes]));
        // Count what the server says it removed, not what we asked for.
        const removed = await removeKeys(sc, p.bucket, [...bySize.keys()]);
        deleted += removed.length;
        for (const key of removed) deletedBytes += bySize.get(key) ?? 0;
        // Only the confirmed ones get their row stamped.
        const confirmed = new Set(removed);
        rowsMarked += await markRowsObjectDeleted(db, p.toDelete.filter((o) => confirmed.has(o.key)));
        await db.query(
          `update public.storage_cleanup_runs
              set objects_deleted = $2, bytes_deleted = $3 where id = $1`,
          [runId, deleted, deletedBytes],
        );
      }
    }

    stage = 'record';
    await db.query(
      `update public.storage_cleanup_runs
          set finished_at = now(), status = 'success',
              objects_deleted = $2, bytes_deleted = $3,
              summary = summary || jsonb_build_object('rowsMarked', $4::int)
        where id = $1`,
      [runId, deleted, deletedBytes, rowsMarked],
    );

    if (asJson) {
      process.stdout.write(
        JSON.stringify({ runId, mode, scanned, planned: plannedCount, deleted, rowsMarked, buckets: entries }, null, 2) + '\n',
      );
      return;
    }

    console.log(`\nStorage cleanup — ${now.toISOString()} — mode=${mode} run=${runId}\n`);
    for (const e of entries) {
      const note = e.blocked
        ? `BLOCKED (${e.blocked}) — ${e.candidates} would have been selected`
        : `${e.candidates} deletable / ${mb(e.bytes)}`;
      console.log(`  ${e.bucket.padEnd(24)} ${String(e.objectCount).padStart(5)} objects  ${note}`);
      for (const k of e.keys) console.log(`      [${k.category}] ${k.key}  ${mb(k.sizeBytes)}  ${k.createdAt ?? '?'}`);
    }
    console.log(
      `\n  scanned ${scanned}, planned ${plannedCount} / ${mb(plannedBytes)}, ` +
        `deleted ${deleted} / ${mb(deletedBytes)}, rows marked ${rowsMarked}, blocked buckets ${blocked}`,
    );
    if (!apply && plannedCount > 0) console.log('  (dry run — nothing was deleted; re-run with --apply)');
    console.log();
  } catch (err) {
    const stageOf = err instanceof StageError ? err.stage : stage;
    const message = err instanceof Error ? err.message : String(err);
    await db
      .query(
        `update public.storage_cleanup_runs
            set finished_at = now(), status = 'error', error_stage = $2, error_message = $3
          where id = $1`,
        [runId, stageOf, message.slice(0, 4000)],
      )
      .catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
