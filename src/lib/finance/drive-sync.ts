import 'server-only';
import { logger } from '@/lib/logger';
import { FINANCE_DRIVE_MAX_ATTEMPTS } from '@/lib/constants/finance';
import {
  getDriveCandidate, listDriveCandidates, markDriveAttempt, markDriveDone, markDriveFailed,
  type DriveCandidate,
} from '@/lib/db/finance/documents';
import { downloadFinanceReceipt } from '@/lib/storage/financeReceiptStorage';
import { DriveNotConnectedError, ensureMonthFolder, openDriveSession, uploadToDrive, type DriveSession } from './drive-client';
import { driveFileName } from './drive-naming';
import { monthFolderParts } from './period';

/**
 * Background backup of receipts to Google Drive.
 *
 * No worker or timer fits this job (Phase 0 finding g: the WhatsApp worker is
 * hard-wired to campaigns), so the copies are made INSIDE the Next process:
 * every upload/save schedules a sync through `after()` (the response returns
 * first), the settings screen offers "נסה שוב", and every new save also
 * retries what is still pending. A failure never blocks a save — the document
 * is marked `failed` with the reason and retried up to
 * FINANCE_DRIVE_MAX_ATTEMPTS times.
 *
 * All work runs through ONE promise chain: the process is single, so this is
 * what keeps two overlapping `after()` calls from uploading the same document
 * twice.
 */

const log = logger.child({ scope: 'finance-drive' });

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

async function syncOne(doc: DriveCandidate, session: DriveSession): Promise<'done' | 'failed'> {
  const attempt = await markDriveAttempt(doc.id);
  try {
    const bytes = await downloadFinanceReceipt(doc.object_key);
    if (!bytes) throw new Error('הקובץ לא נמצא באחסון');
    const date = doc.payment_date ?? doc.period_month;
    const { year, month } = monthFolderParts(date);
    const folderId = await ensureMonthFolder(session, year, month);
    const fileId = await uploadToDrive(session, {
      name: driveFileName({ date, category: doc.category_name, amount: doc.amount, originalName: doc.original_name }),
      mime: doc.mime,
      bytes,
      parentId: folderId,
    });
    await markDriveDone(doc.id, fileId);
    return 'done';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markDriveFailed(doc.id, msg);
    log.warn(`drive upload failed (attempt ${attempt}/${FINANCE_DRIVE_MAX_ATTEMPTS}) doc=${doc.id}: ${msg}`);
    return 'failed';
  }
}

async function runBatch(docs: DriveCandidate[]): Promise<{ done: number; failed: number }> {
  const out = { done: 0, failed: 0 };
  if (docs.length === 0) return out;
  let session: DriveSession;
  try {
    session = await openDriveSession();
  } catch (err) {
    // No account connected: a configuration state, not an upload failure —
    // the documents are marked with the clear reason but NO attempt is
    // consumed, so the connect callback can back up all of them at once.
    // A connected account whose token no longer works IS an attempt.
    const notConnected = err instanceof DriveNotConnectedError;
    const msg = notConnected ? err.message : `חיבור ל-Google Drive נכשל: ${err instanceof Error ? err.message : String(err)}`;
    if (!notConnected) log.warn(`drive session failed: ${msg}`);
    for (const d of docs) {
      if (!notConnected) await markDriveAttempt(d.id);
      await markDriveFailed(d.id, msg);
      out.failed++;
    }
    return out;
  }
  for (const d of docs) {
    if ((await syncOne(d, session)) === 'done') out.done++;
    else out.failed++;
  }
  return out;
}

/** Back up ONE document (by id) — skipped when it is not linked, already done,
 *  or out of attempts. */
export function syncDocument(id: string): Promise<'done' | 'failed' | 'skipped'> {
  return serialize(async () => {
    const doc = await getDriveCandidate(id);
    if (!doc || !doc.entry_id || doc.drive_status === 'done' || doc.drive_attempts >= FINANCE_DRIVE_MAX_ATTEMPTS || doc.object_deleted_at) {
      return 'skipped';
    }
    const r = await runBatch([doc]);
    return r.done ? 'done' : 'failed';
  });
}

/** Back up everything still pending/failed with attempts left, oldest first. */
export function retryPendingDriveUploads(limit = 25, excludeIds: string[] = []): Promise<{ processed: number; done: number; failed: number }> {
  return serialize(async () => {
    const docs = await listDriveCandidates(limit, excludeIds);
    const r = await runBatch(docs);
    return { processed: docs.length, ...r };
  });
}

/** Fire-and-forget for `after()`: never throws, logs instead. */
export function syncDocumentsInBackground(ids: string[]): void {
  for (const id of ids) {
    void syncDocument(id).catch((err) => log.error(`syncDocument crashed doc=${id}`, err));
  }
  // Each save also takes another pass at OLDER failures (the "automatic
  // retry on every new save" rule) — not at the ones just synced above.
  void retryPendingDriveUploads(10, ids).catch((err) => log.error('retryPendingDriveUploads crashed', err));
}
