import 'server-only';

// One-off conversion of the stored document photos that were saved as WebP (the unreleased
// 09/11/2026 build) into the final JPEG form - the same pipeline as a new scan
// (compressVisitorImage: upright, ≤1600px, no metadata, a progressive JPEG ≤~300KB).
//
// Written to be run by scripts/convert-visitor-webp.ts and tested against a real database with a
// stand-in Storage, so the same code that runs on production is the code that was tested.
//
// SAFETY, in the order it matters:
//   * No scan row is ever deleted. A row's two photo columns are changed, in one transaction with
//     an audit row, and only if the row still points at the WebP read a moment ago.
//   * The new object is uploaded BEFORE the row changes and the old one is removed AFTER it, so at
//     every instant the row points at an object that exists. A crash in between leaves a spare
//     object, never a row without a photo - and both keys are logged (bare UUIDs, no personal data).
//   * Each row is addressed by the exact id and key read in this run (CLAUDE.md iron rule 12), never
//     by a filter at write time.
//   * A database error stops the run at that row (the run is safe to repeat). If the answer to COMMIT is
//     lost, the row may already point at the new object, so that object is NOT removed - both keys are
//     logged for a manual check.
//   * Dry run is the default: it reads and reports, writes nothing.

/** What the converter needs from a database connection: a pg Client, or a stand-in. */
export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** What it needs from Storage (the visitor-ids bucket). */
export interface PhotoStore {
  /** The object's bytes, or null when it is missing. */
  download(key: string): Promise<Buffer | null>;
  upload(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** True only when Storage confirmed the removal. */
  remove(key: string): Promise<boolean>;
}

export interface ConvertDeps {
  db: SqlRunner;
  store: PhotoStore;
  /** compressVisitorImage. */
  compress: (input: Buffer) => Promise<{ bytes: Buffer; contentType: string; ext: string }>;
  /** A fresh object key for an extension (`jpg`): `<uuid>.jpg`. */
  newKey: (ext: string) => string;
  log: (line: string) => void;
}

export interface ConvertFailure {
  id: string;
  key: string;
  reason: 'object_missing' | 'unreadable' | 'upload_failed' | 'row_changed' | 'update_failed' | 'commit_unknown';
}

export interface ConvertReport {
  dryRun: boolean;
  /** Rows whose photo is a `.webp`. */
  found: number;
  converted: number;
  failed: ConvertFailure[];
  bytesBefore: number;
  bytesAfter: number;
  /** Old WebP objects whose removal Storage did not confirm (the row is already correct). */
  leftoverOldKeys: string[];
}

interface WebpRow {
  id: string;
  image_object_key: string;
}

export async function convertStoredWebp(deps: ConvertDeps, opts: { apply: boolean }): Promise<ConvertReport> {
  const { db, store, compress, newKey, log } = deps;
  const report: ConvertReport = { dryRun: !opts.apply, found: 0, converted: 0, failed: [], bytesBefore: 0, bytesAfter: 0, leftoverOldKeys: [] };

  const found = await db.query(
    `select id, image_object_key from public.visitor_scans where image_object_key ~* '\\.webp$' order by created_at, id`,
  );
  const rows = found.rows as unknown as WebpRow[];
  report.found = rows.length;
  if (!opts.apply) {
    for (const r of rows) log(`would convert ${r.id} (${r.image_object_key})`);
    return report;
  }

  for (const row of rows) {
    const fail = (reason: ConvertFailure['reason']) => {
      report.failed.push({ id: row.id, key: row.image_object_key, reason });
      log(`FAILED ${row.id} (${row.image_object_key}): ${reason}`);
    };

    const original = await store.download(row.image_object_key).catch(() => null);
    if (!original) { fail('object_missing'); continue; }

    let img: Awaited<ReturnType<ConvertDeps['compress']>>;
    try {
      img = await compress(original);
    } catch {
      fail('unreadable');
      continue;
    }

    const toKey = newKey(img.ext);
    // Logged BEFORE the row changes: a crash between the upload and the commit leaves a spare object
    // that nothing else would ever find (the bucket is outside the Storage GC).
    log(`converting ${row.id}: ${row.image_object_key} -> ${toKey}`);
    try {
      await store.upload(toKey, img.bytes, img.contentType);
    } catch {
      fail('upload_failed');
      continue;
    }

    let swapped = false;
    let stage: 'begin' | 'update' | 'commit' = 'begin';
    try {
      await db.query('begin');
      stage = 'update';
      // The stored name of the camera file follows its new format, so "save image as" on the inline view
      // does not offer a .webp name for JPEG bytes.
      const upd = await db.query(
        `update public.visitor_scans
            set image_object_key = $2, image_bytes = $3,
                image_original_name = regexp_replace(image_original_name, '\\.webp$', '.jpg', 'i')
          where id = $1 and image_object_key = $4`,
        [row.id, toKey, img.bytes.length, row.image_object_key],
      );
      if (upd.rowCount === 1) {
        await db.query(
          `insert into public.audit_log (action, entity_type, entity_id, metadata)
           values ('image_converted', 'visitor_scan', $1, $2::jsonb)`,
          [row.id, JSON.stringify({ old_object_key: row.image_object_key, new_object_key: toKey, old_bytes: original.length, new_image_bytes: img.bytes.length })],
        );
        stage = 'commit';
        await db.query('commit');
        swapped = true;
      } else {
        await db.query('rollback');
      }
    } catch {
      if (stage === 'commit') {
        // The COMMIT may have reached the server although its answer did not come back: the row can
        // already point at toKey, so toKey stays, and so does the old object. Settle it by hand.
        log(`COMMIT UNKNOWN ${row.id}: the row may point at ${toKey}; the old object ${row.image_object_key} was left in place - check the row. Stopping.`);
        report.failed.push({ id: row.id, key: row.image_object_key, reason: 'commit_unknown' });
        break;
      }
      await db.query('rollback').catch(() => undefined);
      await store.remove(toKey);
      fail('update_failed');
      break; // a database error: the connection is suspect - stop here; a re-run picks up where this stopped
    }

    if (!swapped) {
      // Replaced or deleted by someone else since it was read: leave that row alone.
      await store.remove(toKey);
      fail('row_changed');
      continue;
    }

    report.converted++;
    report.bytesBefore += original.length;
    report.bytesAfter += img.bytes.length;
    if (!(await store.remove(row.image_object_key))) {
      report.leftoverOldKeys.push(row.image_object_key);
      log(`old object not removed (row is already correct): ${row.image_object_key}`);
    }
  }
  return report;
}
