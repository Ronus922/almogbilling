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
  type BillingBucket,
  type BucketPlan,
} from '../src/lib/storage/cleanup';
import { auditBucket, collectDbRefs, storageClient } from './storage-audit';

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
  blocked: string | null;
  /** every key the run resolved — the audit trail AND the delete list */
  keys: { key: string; category: string; sizeBytes: number; createdAt: string | null }[];
}

function toEntry(p: BucketPlan): PlanEntry {
  return {
    bucket: p.bucket,
    objectCount: p.objectCount,
    refCount: p.refCount,
    candidates: p.toDelete.length,
    bytes: p.bytes,
    blocked: p.blocked,
    keys: p.toDelete.map((o) => ({
      key: o.key,
      category: o.category,
      sizeBytes: o.sizeBytes,
      createdAt: o.createdAt?.toISOString() ?? null,
    })),
  };
}

/** Remove one explicit list of keys. Unlike the app's deleteObjects(), this
 *  surfaces the error instead of swallowing it — the run row must not claim a
 *  deletion that did not happen. */
async function removeKeys(sc: StorageClient, bucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await sc.from(bucket).remove(keys);
  if (error) throw new StageError('delete', `remove ${bucket} (${keys.length} keys): ${error.message}`);
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

    stage = 'cross_reference';
    const refsByBucket = await collectDbRefs(db);

    stage = 'list';
    const plans: BucketPlan[] = [];
    for (const bucket of BILLING_BUCKETS) {
      const audit = await auditBucket(sc, bucket, refsByBucket, now);
      plans.push(planBucket(bucket, audit.objects, (refsByBucket.get(bucket) ?? []).length));
    }

    const entries = plans.map(toEntry);
    const scanned = plans.reduce((s, p) => s + p.objectCount, 0);
    const blocked = plans.filter((p) => p.blocked !== null).length;
    const plannedBytes = plans.reduce((s, p) => s + p.bytes, 0);
    const plannedCount = plans.reduce((s, p) => s + p.toDelete.length, 0);

    // The delete list is frozen here. Nothing below re-derives it.
    stage = 'delete';
    let deleted = 0;
    let deletedBytes = 0;
    if (apply) {
      for (const p of plans) {
        if (p.blocked !== null || p.toDelete.length === 0) continue;
        await removeKeys(sc, p.bucket, p.toDelete.map((o) => o.key));
        deleted += p.toDelete.length;
        deletedBytes += p.bytes;
      }
    }

    stage = 'record';
    await db.query(
      `update public.storage_cleanup_runs
          set finished_at = now(), status = 'success',
              objects_scanned = $2, objects_deleted = $3, bytes_deleted = $4,
              buckets_blocked = $5, summary = $6::jsonb
        where id = $1`,
      [runId, scanned, deleted, deletedBytes, blocked, JSON.stringify({ mode, buckets: entries })],
    );

    if (asJson) {
      process.stdout.write(
        JSON.stringify({ runId, mode, scanned, planned: plannedCount, deleted, buckets: entries }, null, 2) + '\n',
      );
      return;
    }

    console.log(`\nStorage cleanup — ${now.toISOString()} — mode=${mode} run=${runId}\n`);
    for (const e of entries) {
      const note = e.blocked ? `BLOCKED (${e.blocked})` : `${e.candidates} deletable / ${mb(e.bytes)}`;
      console.log(`  ${e.bucket.padEnd(24)} ${String(e.objectCount).padStart(5)} objects  ${note}`);
      for (const k of e.keys) console.log(`      [${k.category}] ${k.key}  ${mb(k.sizeBytes)}  ${k.createdAt ?? '?'}`);
    }
    console.log(
      `\n  scanned ${scanned}, planned ${plannedCount} / ${mb(plannedBytes)}, ` +
        `deleted ${deleted} / ${mb(deletedBytes)}, blocked buckets ${blocked}`,
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
