import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { VisitorImageError } from './image';
import { MAX_VISITOR_IMAGE_BYTES } from './model';

// The first half of every route that takes a photo of a document (the OCR read, the
// HEIC preview, the admin's re-crop): size limits, the multipart parse, and the image
// pipeline with its errors turned into the answers the screen shows. One place, so
// the three cannot answer the same bad upload differently.

export type ImageUpload<T> = { ok: true; value: T; form: FormData } | { ok: false; response: NextResponse };

const refuse = (error: string, status: number): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ error }, { status }),
});

/** Reads `field` of a multipart body and runs `convert` on its bytes — compressVisitorImage for the
 *  stored form, prepareVisitorImage for the crop step's preview. The parsed form comes back too
 *  (a body can be read once), for the callers that carry another field beside the photo. */
export async function readImageUpload<T>(
  req: NextRequest,
  convert: (input: Buffer) => Promise<T>,
  field = 'image',
): Promise<ImageUpload<T>> {
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
    return { ok: true, value: await convert(Buffer.from(await file.arrayBuffer())), form };
  } catch (err) {
    if (err instanceof VisitorImageError) {
      if (err.code === 'unsupported') return refuse('הקובץ אינו תמונה נתמכת', 415);
      if (err.code === 'too_large') return refuse('התמונה גדולה מדי — צלם ברזולוציה נמוכה יותר', 413);
      return refuse('לא ניתן לפתוח את התמונה — צלם שוב', 422);
    }
    throw err;
  }
}
