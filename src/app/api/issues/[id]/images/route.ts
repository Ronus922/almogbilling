import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getIssueImages, setIssueImages, appendIssueImage } from '@/lib/db/issues';
import {
  uploadIssueImage,
  signedUrlForIssueImage,
  removeIssueImages,
  isPathUnderIssue,
} from '@/lib/storage/issueStorage';
import {
  ISSUE_ALLOWED_IMAGE_TYPES,
  ISSUE_MAX_IMAGE_SIZE_BYTES,
  ISSUE_MAX_IMAGES,
} from '@/lib/constants/issues';
import { isUuid } from '@/lib/validation/issues';
import type { IssueImage } from '@/lib/types/issues';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/issues/[id]/images  (issues:edit) — multipart single-image upload.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const existing = await getIssueImages(id);
  if (existing === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (existing.length >= ISSUE_MAX_IMAGES) {
    return NextResponse.json({ error: 'too_many_images' }, { status: 400 });
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
  if (!ISSUE_ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: 'empty_file' }, { status: 400 });
  }
  if (file.size > ISSUE_MAX_IMAGE_SIZE_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
  }

  let uploadedPath: string | null = null;
  try {
    const { path } = await uploadIssueImage(id, file);
    uploadedPath = path;

    // Atomic append in SQL — the cap is enforced inside the UPDATE, so two
    // concurrent uploads can never push the array past ISSUE_MAX_IMAGES.
    const result = await appendIssueImage(id, path, ISSUE_MAX_IMAGES);
    if (result.status === 'full') {
      await removeIssueImages([path]);
      return NextResponse.json({ error: 'too_many_images' }, { status: 400 });
    }
    if (result.status === 'not_found') {
      await removeIssueImages([path]);
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const image: IssueImage = { path, signed_url: await signedUrlForIssueImage(path) };
    return NextResponse.json({ image, images: result.images }, { status: 201 });
  } catch (err) {
    // If the row update failed after a successful upload, clean up the object.
    if (uploadedPath) await removeIssueImages([uploadedPath]);
    console.error('[POST /api/issues/:id/images]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/issues/[id]/images  (issues:edit) — remove one image by path.
// Body: { path: string }. The path MUST live under this issue's prefix.
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

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

  const current = await getIssueImages(id);
  if (current === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!current.includes(path)) {
    return NextResponse.json({ error: 'image_not_found' }, { status: 404 });
  }

  const next = current.filter((p) => p !== path);
  const saved = await setIssueImages(id, next);
  await removeIssueImages([path]); // best-effort object cleanup after the row is updated
  return NextResponse.json({ images: saved ?? next });
}
