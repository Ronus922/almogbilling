import { outputSize, type Rect } from '@/lib/visitors/crop';
import { CLIENT_UPLOAD_JPEG_QUALITY, CLIENT_UPLOAD_MAX_SIDE } from '@/lib/visitors/model';
import { detectDocumentRect } from '@/lib/visitors/cropDetect';

// The two canvas jobs of the crop step: finding the document on a thumbnail of the
// photo, and cutting the chosen frame out of it. Browser-only (canvas); the maths is
// in lib/visitors/crop*.ts and tested without a browser.

const DETECT_SIDE = 160;

/** The document's frame in the picture's own pixels, or null when the finder is unsure. */
export function detectOnImage(img: HTMLImageElement): Rect | null {
  try {
    const k = Math.min(1, DETECT_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(16, Math.round(img.naturalWidth * k));
    const h = Math.max(16, Math.round(img.naturalHeight * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const found = detectDocumentRect(ctx.getImageData(0, 0, w, h).data, w, h);
    if (!found) return null;
    const sx = img.naturalWidth / w;
    const sy = img.naturalHeight / h;
    return { x: found.x * sx, y: found.y * sy, w: found.w * sx, h: found.h * sy };
  } catch {
    return null; // a canvas that cannot be read is just "no suggestion"
  }
}

/** The frame as a JPEG (≤2000px on its long side, quality 85, never enlarged) — the upload. Drawn in
 *  ONE step from the full-size picture, so a 12MP photo is never copied to a 12MP canvas. The server
 *  makes the final, lighter WebP. */
export function renderCrop(img: HTMLImageElement, frame: Rect, maxSide = CLIENT_UPLOAD_MAX_SIDE): Promise<Blob> {
  const out = outputSize(frame, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas_unavailable'));
  ctx.fillStyle = '#ffffff'; // JPEG has no alpha: a transparent PNG would turn black
  ctx.fillRect(0, 0, out.w, out.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round(frame.x), Math.round(frame.y), Math.round(frame.w), Math.round(frame.h), 0, 0, out.w, out.h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), 'image/jpeg', CLIENT_UPLOAD_JPEG_QUALITY);
  });
}
