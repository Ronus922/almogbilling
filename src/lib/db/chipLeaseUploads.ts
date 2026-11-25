import 'server-only';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '@/lib/db';

// The lease files of the private bucket chip-order-leases, as the database
// knows them (chip_lease_uploads, 25/11/2026) — so a lease that was uploaded
// in the issue window and never saved does not stay in Storage for ever.
//
// THE RULE: a lease file that the issue window uploaded, and that no saved
// order line, holder line or chip points at, is deleted once it is 24 hours
// old. A file that IS attached is never deleted, however old.
//
// ONLY WHAT THIS DATABASE RECORDED. A file gets its row at the moment the issue
// window uploads it (recordLeaseUpload) and in no other way: the purge never
// lists the bucket, and never deletes a file it has no row for. So it can only
// ever delete a file that an instance connected to THIS database uploaded
// itself — an instance that shares the bucket with another database (a
// sandbox pointed at the same Storage) has no row for that database's files
// and cannot touch them. The other side of that choice: a file of the public
// order page, or one uploaded before this table existed, is never swept.
//
// NEVER UNDER A SAVE. The purge deletes a file while holding its row FOR
// UPDATE, after re-checking — under that lock — that nothing points at it. A
// save that attaches a lease takes the same row FOR SHARE first
// (lockLeasesForAttach). So either the save comes first and the purge then
// sees the file attached, or the purge comes first, the row is gone, and the
// save is refused instead of storing a key whose file no longer exists.

/** One query fragment for "something saved points at this key" — a chip (the
 *  issue window), an apartment line or a holder line (the public order page).
 *  `$1` is the key. */
const ATTACHED_SQL = `(
     exists (select 1 from public.chips c where c.lease_file_key = $1)
  or exists (select 1 from public.chip_order_items i where i.lease_file_key = $1)
  or exists (select 1 from public.chip_order_holders h where h.lease_file_key = $1)
)`;

/** The issue window uploaded a lease: its row, with who and when. The only
 *  way a row is ever made. */
export async function recordLeaseUpload(objectKey: string, userId: string | null): Promise<void> {
  await query(
    `insert into public.chip_lease_uploads (object_key, uploaded_by) values ($1, $2)
     on conflict (object_key) do nothing`,
    [objectKey, userId],
  );
}

/** Recorded lease files older than `hours` that nothing saved points at — the
 *  purge's candidates, oldest first, at most `limit` of them. */
export async function listStaleUnattachedLeases(hours: number, limit: number): Promise<string[]> {
  const r = await query<{ object_key: string }>(
    `select u.object_key
       from public.chip_lease_uploads u
      where u.uploaded_at < now() - make_interval(hours => $1)
        and not exists (select 1 from public.chips c where c.lease_file_key = u.object_key)
        and not exists (select 1 from public.chip_order_items i where i.lease_file_key = u.object_key)
        and not exists (select 1 from public.chip_order_holders h where h.lease_file_key = u.object_key)
      order by u.uploaded_at
      limit $2`,
    [hours, limit],
  );
  return r.rows.map((row) => row.object_key);
}

export type LeasePurgeOutcome =
  /** The file and its row are gone. */
  | 'deleted'
  /** Something saved points at it (it was attached meanwhile) — kept. */
  | 'attached'
  /** A save holds it right now, it is not old enough, or it has no row — kept. */
  | 'skipped'
  /** Storage refused — the row stays, the next run retries. */
  | 'file_failed';

/**
 * Deletes ONE lease file if — and only if — it is older than `hours` and
 * nothing saved points at it, re-checked here under the row's lock. The file
 * goes first, the row after: if Storage refuses, the row stays and the next
 * run tries again.
 */
export async function purgeLeaseIfUnattached(
  objectKey: string,
  hours: number,
  remove: (objectKeys: string[]) => Promise<boolean>,
): Promise<LeasePurgeOutcome> {
  return withTransaction(async (client) => {
    const locked = await client.query(
      `select 1 from public.chip_lease_uploads
        where object_key = $1 and uploaded_at < now() - make_interval(hours => $2)
        for update skip locked`,
      [objectKey, hours],
    );
    if ((locked.rowCount ?? 0) === 0) return 'skipped';
    const attached = (await client.query<{ attached: boolean }>(`select ${ATTACHED_SQL} as attached`, [objectKey])).rows[0]!.attached;
    if (attached) return 'attached';
    if (!(await remove([objectKey]))) return 'file_failed';
    await client.query(`delete from public.chip_lease_uploads where object_key = $1`, [objectKey]);
    return 'deleted';
  });
}

/** An order was deleted together with its lease files (an unpaid order, a test
 *  order): their rows go too, in the caller's transaction. */
export async function forgetLeaseUploads(client: Pick<PoolClient, 'query'>, objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  await client.query(`delete from public.chip_lease_uploads where object_key = any($1::text[])`, [objectKeys]);
}

/**
 * A save is about to store these lease keys: their rows are locked FOR SHARE
 * until the save commits, so the purge cannot delete a file under it. Returns
 * the keys that may NOT be stored — a key with no row that nothing saved points
 * at either: its file was purged (or never uploaded through the window).
 * A key with no row that something saved already carries is a lease that was
 * attached before this table existed (or by the public order page); the purge
 * has no row for it and can never delete it, so it passes.
 */
export async function lockLeasesForAttach(client: Pick<PoolClient, 'query'>, objectKeys: string[]): Promise<string[]> {
  const keys = [...new Set(objectKeys)].sort();
  if (keys.length === 0) return [];
  const present = new Set(
    (
      await client.query<{ object_key: string }>(
        `select object_key from public.chip_lease_uploads where object_key = any($1::text[]) order by object_key for share`,
        [keys],
      )
    ).rows.map((r) => r.object_key),
  );
  const missing: string[] = [];
  for (const key of keys) {
    if (present.has(key)) continue;
    const attached = (await client.query<{ attached: boolean }>(`select ${ATTACHED_SQL} as attached`, [key])).rows[0]!.attached;
    if (!attached) missing.push(key);
  }
  return missing;
}
