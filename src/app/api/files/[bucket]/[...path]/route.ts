import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAnyPermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { AuthorizationError } from '@/lib/auth/errors';
import { queryOne } from '@/lib/db';
import { findResidentReceipt } from '@/lib/db/finance/portal';
import { findOwnerIdentity } from '@/lib/db/portal/ownerPhones';
import { logFileView, type FileViewActor, type PortalFileViewer, type ServedFile } from '@/lib/db/fileViewAudit';
import { getPortalSession } from '@/lib/portal/session';
import { getObjectStream, PRIVATE_BUCKETS, type PrivateBucket } from '@/lib/storage/server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx {
  params: Promise<{ bucket: string; path: string[] }>;
}

/**
 * Authenticated file proxy — the ONLY way a stored object reaches a browser.
 * Replaces the old signed URLs, which were bearer tokens: anyone holding the link
 * opened the file with no session and no permission check.
 *
 * Every request re-checks the session and the bucket's module permission, so
 * revoking a permission takes effect immediately instead of one signed-URL TTL later.
 */

/** Per-bucket authorization. A bucket missing from this map is not servable. */
const BUCKET_GUARD: Record<PrivateBucket, () => Promise<Actor>> = {
  'supplier-documents': () => requirePermission('suppliers', 'view'),
  'issue-attachments': () => requirePermission('issues', 'view'),
  // The `documents` bucket backs two modules: the documents browser AND debtor
  // documents (reachable with dashboard:view / contacts:view). Mirror the union
  // the existing routes already grant — still far tighter than a signed URL,
  // which granted access to anyone at all.
  documents: () =>
    requireAnyPermission([
      { module: 'documents', action: 'view' },
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]),
  // WhatsApp attachments — both the broadcast ones and those of a single
  // message. Whoever may see the broadcast history (whatsapp_chat) or the
  // debtor's WhatsApp history (whatsapp) may open them.
  'whatsapp-attachments': () =>
    requireAnyPermission([
      { module: 'whatsapp_chat', action: 'view' },
      { module: 'whatsapp', action: 'view' },
    ]),
  // Finance receipts — whoever may open the finance module (admin+ in slice A).
  // An apartment OWNER may also open one through the portal, under the
  // conditions of residentReceiptViewer() below.
  'finance-receipts': () => requirePermission('finance', 'view'),
};

/**
 * The owners-portal path to a receipt (the portal's document button). Granted
 * only when ALL of these hold; otherwise the staff verdict (401 / 403) stands
 * unchanged, so the response confirms nothing about the object:
 *   • a live portal session (portal_session cookie, phone still an active owner);
 *   • the "הצג מסמכים לדיירים" switch is on;
 *   • the object belongs to a live entry of a PUBLISHED month
 *     (findResidentReceipt checks all three in one place).
 * Returns the viewer for the audit row: actor_user_id NULL, identified by
 * phone + apartments in metadata (see PortalFileViewer).
 */
async function residentReceiptViewer(objectPath: string): Promise<PortalFileViewer | null> {
  const session = await getPortalSession();
  if (!session) return null;
  const receipt = await findResidentReceipt(objectPath);
  if (!receipt) return null;
  const identity = await findOwnerIdentity(session.phoneE164, { onlyActive: true });
  // A mixed-owners phone gets no financial document either (containment
  // 03/10/2026, lib/portal/ownership.ts) — the staff verdict stands.
  if (!identity || identity.mixedOwners) return null;
  return {
    kind: 'portal_owner',
    phoneE164: session.phoneE164,
    ownerName: identity.ownerName,
    apartmentNumbers: identity.apartmentNumbers,
  };
}

/**
 * Object keys are machine-built and ASCII (see lib/storage/objectKey.ts).
 * Anything else — traversal, absolute paths, encoded dots — is rejected before it
 * can reach Storage. SEGMENT_RE is what actually blocks traversal: no slashes, no
 * bare dots.
 *
 * The leaf must OPEN with a random UUID, which both formats in the DB satisfy:
 *   current: `<uuid>.pdf`
 *   legacy:  `<uuid>-2022-09-24_13.08.58.jpg`  (supplier-documents)
 * Requiring a full-string `<uuid>.<ext>` would 404 every legacy supplier document.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const LEAF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.-][A-Za-z0-9._-]*)?$/i;

function isSafePath(segments: string[]): boolean {
  if (segments.length === 0 || segments.length > 3) return false;
  if (segments.some((s) => !SEGMENT_RE.test(s) || s === '.' || s === '..')) return false;
  return LEAF_RE.test(segments[segments.length - 1]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The served object as its owning table knows it: the readable (Hebrew) name
 * for Content-Disposition, and the parent entity for the audit row — named
 * exactly as the matching upload audit row names it, so the supplier activity
 * tab (entity_type='supplier') lists views next to uploads.
 * An object no table claims (orphan) is still served and still logged, under
 * entity_type='file'.
 */
function unclaimedFile(bucket: PrivateBucket, path: string): ServedFile {
  return { bucket, objectKey: path, fileName: null, entityType: 'file', entityId: `${bucket}/${path}` };
}

async function describeStoredFile(bucket: PrivateBucket, path: string): Promise<ServedFile> {
  const base = { bucket, objectKey: path };
  const orphan = unclaimedFile(bucket, path);

  if (bucket === 'documents') {
    const row = await queryOne<{ id: string; file_name: string; entity_type: string | null; entity_id: string | null }>(
      `select id, file_name, entity_type, entity_id from public.documents where storage_path = $1 limit 1`,
      [path],
    );
    if (!row) return orphan;
    return {
      ...base,
      fileName: row.file_name,
      entityType: 'document',
      entityId: row.id,
      extra: row.entity_type === 'debtor' && row.entity_id ? { debtor_id: row.entity_id } : undefined,
    };
  }
  if (bucket === 'supplier-documents') {
    const row = await queryOne<{ id: string; supplier_id: string; file_name: string }>(
      `select id, supplier_id, file_name from public.supplier_documents where file_url = $1 limit 1`,
      [path],
    );
    if (!row) return orphan;
    return { ...base, fileName: row.file_name, entityType: 'supplier', entityId: row.supplier_id, documentId: row.id };
  }
  if (bucket === 'whatsapp-attachments') {
    // One bucket, two owners: a broadcast's files and a single message's.
    const row = await queryOne<{ id: string; campaign_id: string | null; original_name: string }>(
      `select id, campaign_id, original_name from public.wa_campaign_attachments where object_key = $1 limit 1`,
      [path],
    );
    if (row) {
      return row.campaign_id
        ? { ...base, fileName: row.original_name, entityType: 'wa_campaign', entityId: row.campaign_id, documentId: row.id }
        : { ...base, fileName: row.original_name, entityType: 'wa_campaign_attachment', entityId: row.id };
    }
    const msgRow = await queryOne<{ id: string; message_id: string | null; original_name: string }>(
      `select id, message_id, original_name from public.wa_message_attachments where object_key = $1 limit 1`,
      [path],
    );
    if (!msgRow) return orphan;
    return msgRow.message_id
      ? { ...base, fileName: msgRow.original_name, entityType: 'wa_message', entityId: msgRow.message_id, documentId: msgRow.id }
      : { ...base, fileName: msgRow.original_name, entityType: 'wa_message_attachment', entityId: msgRow.id };
  }
  if (bucket === 'finance-receipts') {
    const row = await queryOne<{ id: string; entry_id: string | null; original_name: string }>(
      `select id, entry_id, original_name from public.fin_documents where object_key = $1 limit 1`,
      [path],
    );
    if (!row) return orphan;
    // Mirrors `document_removed`: the entry is the parent, the receipt id rides in metadata.
    return row.entry_id
      ? { ...base, fileName: row.original_name, entityType: 'fin_entry', entityId: row.entry_id, documentId: row.id }
      : { ...base, fileName: row.original_name, entityType: 'fin_document', entityId: row.id };
  }
  // issue-attachments: bare paths `<issueId>/<uuid>.<ext>`, no display name — the
  // prefix IS the parent (enforced at upload by buildObjectKey / isPathUnderIssue).
  const [prefix] = path.split('/');
  if (UUID_RE.test(prefix)) return { ...base, fileName: null, entityType: 'issue', entityId: prefix };
  return orphan;
}

/** RFC 5987: ASCII fallback + UTF-8 form so a Hebrew name survives. */
function contentDisposition(name: string | null): string {
  if (!name) return 'inline';
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { bucket, path } = await ctx.params;

  // Unknown bucket → 404, never 403: don't confirm what buckets exist.
  if (!(PRIVATE_BUCKETS as readonly string[]).includes(bucket)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const known = bucket as PrivateBucket;

  // The path is validated before the guard only because the portal branch of
  // finance-receipts needs the object key to decide; the check itself reveals
  // nothing (a bad path is a 404 whoever asks).
  const segments = path.map((s) => decodeURIComponent(s));
  if (!isSafePath(segments)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const objectPath = segments.join('/');

  let actor: FileViewActor | PortalFileViewer;
  try {
    actor = await BUCKET_GUARD[known]();
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    // Not staff (or staff without finance:view). A receipt may still be served
    // to an owner through the portal — otherwise the staff verdict stands.
    const viewer = known === 'finance-receipts' ? await residentReceiptViewer(objectPath) : null;
    if (!viewer) {
      const r = authErrorResponse(err);
      if (r) return r;
      throw err;
    }
    actor = viewer;
  }

  let blob: Blob | null;
  try {
    blob = await getObjectStream(known, objectPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[GET /api/files] storage not configured');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    logger.error(`[GET /api/files/${bucket}] download failed`, err);
    return NextResponse.json({ error: 'download_failed' }, { status: 502 });
  }
  if (!blob) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Permission passed and the object exists: record the view (F9), then serve.
  // Neither step may withhold the file — the owner lookup falls back to the
  // bare object and logFileView never throws.
  let file: ServedFile;
  try {
    file = await describeStoredFile(known, objectPath);
  } catch (err) {
    logger.error(`[GET /api/files/${bucket}] owner lookup failed`, err);
    file = unclaimedFile(known, objectPath);
  }
  await logFileView(req, actor, file);

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'Content-Disposition': contentDisposition(file.fileName),
      'Content-Length': String(blob.size),
      'Cache-Control': 'private, no-store',
    },
  });
}
