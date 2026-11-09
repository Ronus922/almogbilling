import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { prepareVisitorImage, VisitorImageError } from './image';
import { MAX_VISITOR_IMAGE_BYTES } from './model';

// The first half of every route that takes a photo of a document (the OCR read, the
// HEIC preview, the admin's re-crop): size limits, the multipart parse, and the image
// pipeline with its errors turned into the answers the screen shows. One place, so
// the three cannot answer the same bad upload differently.

export type ImageUpload = { ok: true; jpeg: Buffer } | { ok: false; response: NextResponse };

const refuse = (error: string, status: number): ImageUpload => ({ ok: false, response: NextResponse.json({ error }, { status }) });

/** Reads `field` of a multipart body and normalises it (upright JPEG, ≤1600px, no metadata). */
export async function readImageUpload(req: NextRequest, field = 'image'): Promise<ImageUpload> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_VISITOR_IMAGE_BYTES + 64 * 1024) return refuse('התמונה גדולה מדי', 413);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse('בקשה לא תקינה', 400);
  }
  const file = form.get(field);
  if (!(file instanceof File) || file.size === 0) return refuse('לא נשלחה תמונה', 400);
  if (file.size > MAX_VISITOR_IMAGE_BYTES) return refuse('התמונה גדולה מדי', 413);

  try {
    return { ok: true, jpeg: (await prepareVisitorImage(Buffer.from(await file.arrayBuffer()))).jpeg };
  } catch (err) {
    if (err instanceof VisitorImageError) {
      if (err.code === 'unsupported') return refuse('הקובץ אינו תמונה נתמכת', 415);
      if (err.code === 'too_large') return refuse('התמונה גדולה מדי — צלם ברזולוציה נמוכה יותר', 413);
      return refuse('לא ניתן לפתוח את התמונה — צלם שוב', 422);
    }
    throw err;
  }
}
