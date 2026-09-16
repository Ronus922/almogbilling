// scripts/storage-audit.ts — READ-ONLY inventory of every billing Supabase
// Storage bucket, cross-referenced with every DB column that points at Storage.
//
//   npx tsx scripts/storage-audit.ts            # human table
//   npx tsx scripts/storage-audit.ts --json     # machine-readable (full object list)
//   npx tsx scripts/storage-audit.ts --list     # also print every object, per category
//
// Writes NOTHING — no delete, no move, no DB write. It is the evidence source
// for the cleanup decisions; the job that actually deletes is
// scripts/storage-cleanup.ts. Both share the pure decision logic in
// src/lib/storage/cleanup.ts — classification lives in exactly one place.
//
// Categories per object:
//   linked   — a live DB row points at it
//   staged   — an attachment row exists but is not yet bound to a message /
//              campaign; `staged_old` once it is older than STAGED_MAX_AGE_H
//   zombie   — no DB row anywhere references it
//   trash    — already parked under the `_trash/` prefix
// And the mirror image: DB rows whose object is missing from Storage (orphans).
//
// DATABASE_URL / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY come from
// the environment or .env.local.
import dotenv from 'dotenv';
import { Client } from 'pg';
import { StorageClient } from '@supabase/storage-js';
import {
  BILLING_BUCKETS,
  classify,
  waMediaKeyFromUrl,
  type BillingBucket,
  type Category,
  type ClassifiedObject,
  type DbRef,
  type OrphanRow,
  type StorageObject,
} from '../src/lib/storage/cleanup';

dotenv.config({ path: '.env.local', quiet: true });

// ─────────────────────────────────────────────────────────────────────
// Storage listing (read-only)
// ─────────────────────────────────────────────────────────────────────

/** Service-role Storage client. Exported so scripts/storage-cleanup.ts
 *  reuses this exact construction instead of repeating it. */
export function storageClient(): StorageClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase_storage_not_configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  return new StorageClient(`${url.replace(/\/$/, '')}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
}

const PAGE = 1000;

/** Depth-first walk of a bucket. `.list()` returns files (id != null) and
 *  pseudo-folders (id == null) one level at a time, so recurse per folder. */
async function listBucket(sc: StorageClient, bucket: BillingBucket): Promise<StorageObject[]> {
  const out: StorageObject[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const prefix = queue.shift() as string;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sc.from(bucket).list(prefix, { limit: PAGE, offset });
      if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const entry of data) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id == null) {
          queue.push(key);
        } else {
          const meta = (entry.metadata ?? {}) as { size?: number };
          out.push({
            bucket,
            key,
            sizeBytes: Number(meta.size ?? 0),
            createdAt: entry.created_at ? new Date(entry.created_at) : null,
            updatedAt: entry.updated_at ? new Date(entry.updated_at) : null,
          });
        }
      }
      if (data.length < PAGE) break;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// DB references — every column in the schema that holds a Storage key
// ─────────────────────────────────────────────────────────────────────

/**
 * Collects every DB pointer into Storage, keyed by bucket.
 *   documents.storage_path            → documents
 *   issues.images[] / issues.videos[] → issue-attachments
 *   supplier_documents.file_url       → supplier-documents
 *   wa_campaign_attachments.object_key / wa_message_attachments.object_key
 *                                     → whatsapp-attachments (bucket column wins)
 *   chat_messages.media_url           → whatsapp-media (URL → key)
 */
export async function collectDbRefs(db: Client): Promise<Map<string, DbRef[]>> {
  const byBucket = new Map<string, DbRef[]>();
  const push = (bucket: string, ref: DbRef) => {
    const list = byBucket.get(bucket);
    if (list) list.push(ref);
    else byBucket.set(bucket, [ref]);
  };

  const docs = await db.query<{ id: string; storage_path: string; created_at: Date }>(
    `select id, storage_path, created_at from public.documents where storage_path is not null`,
  );
  for (const r of docs.rows) {
    push('documents', { key: r.storage_path, table: 'documents', column: 'storage_path', rowId: r.id, bound: true, createdAt: r.created_at });
  }

  const issues = await db.query<{ id: string; path: string; created_at: Date; col: string }>(
    `select id, unnest(images) as path, created_at, 'images' as col from public.issues
     union all
     select id, unnest(videos) as path, created_at, 'videos' as col from public.issues`,
  );
  for (const r of issues.rows) {
    push('issue-attachments', { key: r.path, table: 'issues', column: r.col, rowId: r.id, bound: true, createdAt: r.created_at });
  }

  const supplierDocs = await db.query<{ id: string; file_url: string; created_at: Date }>(
    `select id, file_url, created_at from public.supplier_documents where file_url is not null`,
  );
  for (const r of supplierDocs.rows) {
    push('supplier-documents', { key: r.file_url, table: 'supplier_documents', column: 'file_url', rowId: r.id, bound: true, createdAt: r.created_at });
  }

  const campaignAtt = await db.query<{ id: string; bucket: string; object_key: string; created_at: Date; bound: boolean }>(
    `select id, bucket, object_key, created_at, campaign_id is not null as bound
       from public.wa_campaign_attachments`,
  );
  for (const r of campaignAtt.rows) {
    push(r.bucket, { key: r.object_key, table: 'wa_campaign_attachments', column: 'object_key', rowId: r.id, bound: r.bound, createdAt: r.created_at });
  }

  const messageAtt = await db.query<{ id: string; bucket: string; object_key: string; created_at: Date; bound: boolean }>(
    `select id, bucket, object_key, created_at, message_id is not null as bound
       from public.wa_message_attachments`,
  );
  for (const r of messageAtt.rows) {
    push(r.bucket, { key: r.object_key, table: 'wa_message_attachments', column: 'object_key', rowId: r.id, bound: r.bound, createdAt: r.created_at });
  }

  const media = await db.query<{ id: string; media_url: string; created_at: Date }>(
    `select id, media_url, created_at from public.chat_messages where media_url is not null`,
  );
  for (const r of media.rows) {
    const key = waMediaKeyFromUrl(r.media_url);
    if (key) push('whatsapp-media', { key, table: 'chat_messages', column: 'media_url', rowId: r.id, bound: true, createdAt: r.created_at });
  }

  return byBucket;
}

// ─────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────

export interface BucketAudit {
  bucket: BillingBucket;
  objects: ClassifiedObject[];
  orphanRows: OrphanRow[];
  totals: Record<Category, { count: number; bytes: number }>;
}

export async function auditBucket(
  sc: StorageClient,
  bucket: BillingBucket,
  refsByBucket: Map<string, DbRef[]>,
  now: Date,
): Promise<BucketAudit> {
  const objects = await listBucket(sc, bucket);
  const refs = refsByBucket.get(bucket) ?? [];
  const refsByKey = new Map<string, DbRef[]>();
  for (const r of refs) {
    const list = refsByKey.get(r.key);
    if (list) list.push(r);
    else refsByKey.set(r.key, [r]);
  }
  const present = new Set(objects.map((o) => o.key));

  const classified: ClassifiedObject[] = objects.map((o) => {
    const objRefs = refsByKey.get(o.key) ?? [];
    return { ...o, refs: objRefs, category: classify(o, objRefs, now) };
  });

  const orphanRows: OrphanRow[] = refs
    .filter((r) => !present.has(r.key))
    .map((r) => ({ ...r, bucket }));

  const totals = {
    linked: { count: 0, bytes: 0 },
    staged: { count: 0, bytes: 0 },
    staged_old: { count: 0, bytes: 0 },
    zombie: { count: 0, bytes: 0 },
    trash: { count: 0, bytes: 0 },
  } satisfies Record<Category, { count: number; bytes: number }>;
  for (const o of classified) {
    totals[o.category].count += 1;
    totals[o.category].bytes += o.sizeBytes;
  }

  return { bucket, objects: classified, orphanRows, totals };
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function pad(v: string, w: number): string {
  return v.length >= w ? v : v + ' '.repeat(w - v.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const withList = args.includes('--list');

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const db = new Client({ connectionString: url });
  await db.connect();
  const sc = storageClient();
  const now = new Date();

  try {
    const refsByBucket = await collectDbRefs(db);
    const audits: BucketAudit[] = [];
    for (const bucket of BILLING_BUCKETS) {
      audits.push(await auditBucket(sc, bucket, refsByBucket, now));
    }

    if (asJson) {
      process.stdout.write(JSON.stringify({ generatedAt: now.toISOString(), audits }, null, 2) + '\n');
      return;
    }

    const cats: Category[] = ['linked', 'staged', 'staged_old', 'zombie', 'trash'];
    console.log(`\nStorage audit — ${now.toISOString()} (read-only)\n`);
    console.log(
      pad('bucket', 24) + cats.map((c) => pad(c, 20)).join('') + pad('orphan rows', 12) + 'total',
    );
    console.log('-'.repeat(24 + cats.length * 20 + 12 + 8));
    const grand = { count: 0, bytes: 0, orphans: 0 };
    for (const a of audits) {
      const total = a.objects.reduce((s, o) => s + o.sizeBytes, 0);
      grand.count += a.objects.length;
      grand.bytes += total;
      grand.orphans += a.orphanRows.length;
      console.log(
        pad(a.bucket, 24) +
          cats.map((c) => pad(`${a.totals[c].count} / ${mb(a.totals[c].bytes)}`, 20)).join('') +
          pad(String(a.orphanRows.length), 12) +
          `${a.objects.length} / ${mb(total)}`,
      );
    }
    console.log('-'.repeat(24 + cats.length * 20 + 12 + 8));
    console.log(`${pad('TOTAL', 24)}${pad('', cats.length * 20)}${pad(String(grand.orphans), 12)}${grand.count} / ${mb(grand.bytes)}\n`);

    for (const a of audits) {
      const noteworthy = a.objects.filter((o) => o.category !== 'linked');
      if (noteworthy.length === 0 && a.orphanRows.length === 0) continue;
      console.log(`── ${a.bucket} ─────────────────────────────`);
      for (const o of noteworthy) {
        console.log(`  [${o.category}] ${o.key}  ${mb(o.sizeBytes)}  ${o.createdAt?.toISOString() ?? '?'}`);
      }
      for (const r of a.orphanRows) {
        console.log(`  [ORPHAN ROW] ${r.table}.${r.column} id=${r.rowId} → missing object ${r.key}`);
      }
      if (withList) {
        for (const o of a.objects.filter((x) => x.category === 'linked')) {
          console.log(`  [linked] ${o.key}  ${mb(o.sizeBytes)}  ← ${o.refs.map((r) => `${r.table}#${r.rowId}`).join(', ')}`);
        }
      }
      console.log();
    }
  } finally {
    await db.end();
  }
}

// Only run when invoked directly — the module is also imported by the unit tests.
if (process.argv[1] && process.argv[1].endsWith('storage-audit.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
