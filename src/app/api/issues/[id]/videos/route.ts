import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { actorMayAccessIssueId } from '@/lib/auth/issueAccess';
import { getIssueVideos, setIssueVideos, appendIssueVideo } from '@/lib/db/issues';
import {
  uploadIssueVideo,
  imageUrlForPath as mediaUrlForPath,
  removeIssueImages as removeIssueMedia,
  isPathUnderIssue,
} from '@/lib/storage/issueStorage';
import {
  ISSUE_ALLOWED_VIDEO_TYPES,
  ISSUE_MAX_VIDEO_SIZE_BYTES,
  ISSUE_MAX_VIDEOS,
} from '@/lib/constants/issues';
import { isUuid } from '@/lib/validation/issues';
import type { IssueImage } from '@/lib/types/issues';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/issues/[id]/videos  (issues:edit) — multipart single-video upload.
// 1:1 with the images route: video paths live in the SAME issue-attachments
// bucket, guarded by isPathUnderIssue, served only through /api/files.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const existing = await getIssueVideos(id);
  if (existing === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Field-worker isolation (write): attach videos only to an assigned issue.
  if (!(await actorMayAccessIssueId(actor, id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (existing.length >= ISSUE_MAX_VIDEOS) {
    return NextResponse.json({ error: 'too_many_videos' }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  // Server-side validation — type, size. (Name is sanitised in the storage layer.)
  if (!ISSUE_ALLOWED_VIDEO_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: 'empty_file' }, { status: 400 });
  }
  if (file.size > ISSUE_MAX_VIDEO_SIZE_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
  }

  let uploadedPath: string | null = null;
  try {
    const { path } = await uploadIssueVideo(id, file);
    uploadedPath = path;

    // Atomic append in SQL — the cap is enforced inside the UPDATE, so two
    // concurrent uploads can never push the array past ISSUE_MAX_VIDEOS.
    const result = await appendIssueVideo(id, path, ISSUE_MAX_VIDEOS);
    if (result.status === 'full') {
      await removeIssueMedia([path]);
      return NextResponse.json({ error: 'too_many_videos' }, { status: 400 });
    }
    if (result.status === 'not_found') {
      await removeIssueMedia([path]);
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const video: IssueImage = { path, signed_url: mediaUrlForPath(path) };
    return NextResponse.json({ video, videos: result.videos }, { status: 201 });
  } catch (err) {
    if (uploadedPath) await removeIssueMedia([uploadedPath]);
    logger.error('[POST /api/issues/:id/videos]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/issues/[id]/videos  (issues:edit) — remove one video by path.
// Body: { path: string }. The path MUST live under this issue's prefix.
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Field-worker isolation (write): remove videos only from an assigned issue.
  if (!(await actorMayAccessIssueId(actor, id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const path = typeof (body as Record<string, unknown>)?.path === 'string'
    ? (body as { path: string }).path
    : '';
  if (!path || !isPathUnderIssue(path, id)) {
    return NextResponse.json({ error: 'invalid_path' }, { status: 400 });
  }

  const current = await getIssueVideos(id);
  if (current === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!current.includes(path)) {
    return NextResponse.json({ error: 'video_not_found' }, { status: 404 });
  }

  const next = current.filter((p) => p !== path);
  const saved = await setIssueVideos(id, next);
  await removeIssueMedia([path]); // best-effort object cleanup after the row is updated
  return NextResponse.json({ videos: saved ?? next });
}
