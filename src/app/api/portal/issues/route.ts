import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { requirePortalSession, type PortalSession } from '@/lib/portal/session';
import {
  PORTAL_IMAGE_MESSAGES, PORTAL_ISSUE_MAX_IMAGES, portalImageError, validatePortalIssueReport,
  type PortalIssueReceipt,
} from '@/lib/portal/issueReport';
import { insertPortalIssue, resolvePortalReporter } from '@/lib/db/portal/issueReport';
import { removeIssueImages, uploadIssueImage } from '@/lib/storage/issueStorage';
import { notifyAdminsOfIssueReported } from '@/services/issueReported';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const FILE_ERROR_MESSAGES = {
  invalid_file_type: PORTAL_IMAGE_MESSAGES.notImage,
  empty_file: PORTAL_IMAGE_MESSAGES.unreadable,
  file_too_large: PORTAL_IMAGE_MESSAGES.tooLarge,
} as const;

/**
 * POST /api/portal/issues — an owner reports a fault in a common area
 * (multipart: location, area, description, urgency, images[] ×0–5).
 *
 * Write-only by design. The resident never reads an issue — not even their
 * own — so the 201 carries only what the confirmation screen prints (call
 * number, location, urgency, photo count), never the issue id or any field of
 * the row.
 *
 *   • Who reported comes from the portal SESSION only: requirePortalSession()
 *     → the phone → its roster row (lowest apartment number). Any reporter /
 *     phone / apartment key in the body is simply never read.
 *   • The text fields pass validatePortalIssueReport — the same function the
 *     screen validates with — and every photo the issues module's existing
 *     gate: jpeg/png/webp, ≤ 5MB, at most 5 (the screen compresses first).
 *   • Photos go to the private issue-attachments bucket under `<issueId>/`
 *     (uuid keys, served only through /api/files to staff with issues:view)
 *     BEFORE the row is written, and the row is one INSERT — so staff never see
 *     a half-made report. Any failure removes the uploaded objects.
 *   • The existing "תקלה חדשה נפתחה" bell goes to every active admin.
 */
export async function POST(req: NextRequest) {
  let session: PortalSession;
  try {
    session = await requirePortalSession();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const fields = validatePortalIssueReport({
    location: form.get('location'),
    area: form.get('area'),
    description: form.get('description'),
    urgency: form.get('urgency'),
  });
  if (!fields.ok) {
    return NextResponse.json({ error: 'invalid_fields', errors: fields.errors }, { status: 400 });
  }

  const entries = form.getAll('images');
  if (entries.some((e) => !(e instanceof File))) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const files = entries as File[];
  if (files.length > PORTAL_ISSUE_MAX_IMAGES) {
    return NextResponse.json({ error: 'too_many_images', message: PORTAL_IMAGE_MESSAGES.tooMany }, { status: 400 });
  }
  for (const file of files) {
    const bad = portalImageError(file);
    if (bad) return NextResponse.json({ error: bad, message: FILE_ERROR_MESSAGES[bad] }, { status: 400 });
  }

  // The session guard has just confirmed an active owner; a roster change in
  // the instant since then is a lost session, not a bad request.
  const reporter = await resolvePortalReporter(session.phoneE164);
  if (!reporter) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 });

  const id = randomUUID();
  const uploaded: string[] = [];
  try {
    for (const file of files) {
      const { path } = await uploadIssueImage(id, file);
      uploaded.push(path);
    }
    const created = await insertPortalIssue({ id, report: fields.value, reporter, images: uploaded });

    void notifyAdminsOfIssueReported(
      { id: created.id, title: created.title, description: created.description },
      null,
    );

    const report: PortalIssueReceipt = {
      ticketNumber: created.ticketNumber,
      location: fields.value.location,
      area: fields.value.area,
      urgency: fields.value.urgency,
      imageCount: uploaded.length,
    };
    return NextResponse.json({ report }, { status: 201 });
  } catch (err) {
    if (uploaded.length > 0) await removeIssueImages(uploaded);
    logger.error('[POST /api/portal/issues]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
