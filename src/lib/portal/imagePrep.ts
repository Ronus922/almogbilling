// Browser-only: turn a picked photo into something the issues module accepts
// (jpeg/png/webp, ≤ 5MB) before it ever leaves the phone. The decision itself
// is decideImagePrep() (issueReport.ts, pure and unit-tested); this file only
// does the decoding and the drawing. No third-party library (decision
// 03/10/2026).
//
//   • over 8MB                  → refused at once, no attempt to shrink it;
//   • small jpeg/png/webp       → uploaded as is;
//   • anything else             → drawn on a canvas, longest edge ≤ 2000px,
//                                 JPEG @ 0.82. The canvas copy carries no EXIF
//                                 at all — GPS included — which is wanted.
//   • HEIC/HEIF (iPhone)        → converted the same way when the browser can
//                                 decode it (Safari can); otherwise a clear
//                                 error. Still over 5MB after that → refused.
//
// Orientation: a phone photo is stored sideways plus an EXIF rotation flag.
// createImageBitmap(…, { imageOrientation: 'from-image' }) applies the flag,
// so width/height and the pixels are upright. A browser that rejects that
// option falls back to an <img>, which every current engine draws upright.
import {
  PORTAL_IMAGE_JPEG_QUALITY, PORTAL_IMAGE_MAX_EDGE, PORTAL_IMAGE_MAX_INPUT_BYTES, PORTAL_IMAGE_MAX_UPLOAD_BYTES,
  PORTAL_IMAGE_MESSAGES, decideImagePrep,
} from './issueReport';

export type PreparedImage = { ok: true; file: File } | { ok: false; error: string };

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decodeWithBitmap(file: File): Promise<Decoded> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
}

async function decodeWithImg(file: File): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function decode(file: File): Promise<Decoded | null> {
  try {
    return await decodeWithBitmap(file);
  } catch {
    try {
      return await decodeWithImg(file);
    } catch {
      return null;
    }
  }
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '') || 'photo';
  return `${base}.jpg`;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > PORTAL_IMAGE_MAX_INPUT_BYTES) return { ok: false, error: PORTAL_IMAGE_MESSAGES.tooLarge };
  // accept="image/*" keeps most pickers to photos, but not all of them; an
  // empty type (some Android file managers) is given the benefit of the doubt
  // and decided by the decoder.
  if (file.type && !file.type.startsWith('image/')) return { ok: false, error: PORTAL_IMAGE_MESSAGES.notImage };

  const img = await decode(file);
  if (!img || img.width === 0 || img.height === 0) {
    img?.release();
    return { ok: false, error: PORTAL_IMAGE_MESSAGES.unreadable };
  }

  try {
    if (decideImagePrep({ size: file.size, type: file.type, width: img.width, height: img.height }) === 'as_is') {
      return { ok: true, file };
    }

    const scale = Math.min(1, PORTAL_IMAGE_MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: PORTAL_IMAGE_MESSAGES.unreadable };
    // JPEG has no alpha: a transparent PNG would otherwise turn black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.source, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PORTAL_IMAGE_JPEG_QUALITY));
    if (!blob) return { ok: false, error: PORTAL_IMAGE_MESSAGES.unreadable };
    if (blob.size > PORTAL_IMAGE_MAX_UPLOAD_BYTES) return { ok: false, error: PORTAL_IMAGE_MESSAGES.tooLarge };
    return { ok: true, file: new File([blob], jpegName(file.name), { type: 'image/jpeg' }) };
  } finally {
    img.release();
  }
}
