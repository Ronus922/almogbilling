import 'server-only';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { VISITOR_IMAGE_MAX_SIDE } from './model';

// One entry point for every photo of a document: whatever the phone sent
// (JPEG, PNG, WebP, HEIC / HEIF) comes out as ONE shape — an upright JPEG, at
// most 1600px on its long side, with no metadata. The OCR reads that, the
// Storage keeps that, the screen shows that.
//
// Stripping the metadata is deliberate: a phone photo carries GPS coordinates
// and the device model in EXIF, none of which belongs next to an ID document.
//
// HEIC needs its own decoder. The libvips prebuilt inside sharp reads AVIF but
// not HEVC (the codec of an iPhone's HEIC), so a HEIC is decoded by
// heic-convert (libheif compiled to WASM, bundled — no native build, no file
// read at runtime) into a JPEG first, and sharp does the rest. iOS Safari
// usually converts to JPEG on its own for <input accept="image/*">, so this
// path is the safety net, not the common case.

export type ImageErrorCode = 'empty' | 'unsupported' | 'corrupt' | 'too_large';

export class VisitorImageError extends Error {
  constructor(readonly code: ImageErrorCode) {
    super(`visitor_image_${code}`);
    this.name = 'VisitorImageError';
  }
}

export interface PreparedImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

// Brands of the ISO-BMFF family an iPhone / Android writes for HEIC and HEIF.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** True when the bytes are a HEIC / HEIF file: `....ftyp<brand>` at the start. */
export function isHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  return HEIF_BRANDS.has(buf.toString('latin1', 8, 12));
}

/** The largest picture a HEIC may declare. An iPhone's default is 12MP; 25MP leaves room for any
 *  phone's "high resolution" mode. The decoder allocates width × height × 4 bytes of RGBA from the
 *  FILE's own header and runs synchronously on the server's only thread (≈1.6s and +230MB for 12MP),
 *  so a forged header must be refused BEFORE it, and a 48MP photo is asked to be retaken. */
export const MAX_HEIC_PIXELS = 25_000_000;

/** Reads the `ispe` (image spatial extents) of every image a HEIC declares by WALKING its boxes —
 *  ftyp · meta (a full box: 4 bytes of version/flags first) › iprp › ipco › ispe — instead of
 *  searching the bytes for the word. A search would find the tag inside compressed pixels (rare,
 *  but a false "too large"), and could be fooled by a tag planted outside the real tree. */
function collectExtents(buf: Buffer, start: number, end: number, out: number[], depth = 0): void {
  if (depth > 4) return;
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at; // "to the end of the file"
    }
    if (size < header || at + size > end) return;
    const body = at + header;
    const boxEnd = at + size;
    if (type === 'ispe' && boxEnd - body >= 12) out.push(buf.readUInt32BE(body + 4) * buf.readUInt32BE(body + 8));
    else if (type === 'meta') collectExtents(buf, body + 4, boxEnd, out, depth + 1);
    else if (type === 'iprp' || type === 'ipco') collectExtents(buf, body, boxEnd, out, depth + 1);
    at += size;
  }
}

/** Width × height of the largest image a HEIC declares; 0 when it declares none. */
export function heicPixels(buf: Buffer): number {
  const out: number[] = [];
  collectExtents(buf, 0, buf.length, out);
  return out.reduce((max, v) => Math.max(max, v), 0);
}

// One HEIC decode at a time: it blocks the event loop and takes ~230MB, so two at once would
// add up. A queue of promises is all the mutual exclusion a single-process server needs.
let heicQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = heicQueue.then(task, task);
  heicQueue = run.catch(() => undefined);
  return run;
}

// What a phone camera / a library photo can be. sharp would also open SVG, GIF and
// TIFF — formats nobody photographs a document in, and SVG is a renderer surface.
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);

export async function prepareVisitorImage(input: Buffer): Promise<PreparedImage> {
  if (input.length === 0) throw new VisitorImageError('empty');

  let source: Buffer = input;
  if (isHeic(input)) {
    const pixels = heicPixels(input);
    if (pixels === 0) throw new VisitorImageError('corrupt'); // a real HEIC always declares its size
    if (pixels > MAX_HEIC_PIXELS) throw new VisitorImageError('too_large');
    try {
      source = Buffer.from(await oneAtATime(() => heicConvert({ buffer: input, format: 'JPEG', quality: 0.9 })));
    } catch {
      throw new VisitorImageError('corrupt');
    }
  }

  try {
    const format = (await sharp(source, { failOn: 'error' }).metadata()).format;
    if (!format || !ALLOWED_FORMATS.has(format)) throw new VisitorImageError('unsupported');
    // rotate() with no argument applies the EXIF orientation and drops the tag, so the
    // photo is upright for the OCR and for every viewer; the encoder keeps no metadata.
    const out = await sharp(source, { failOn: 'error', limitInputPixels: 120_000_000 })
      .rotate()
      .resize({
        width: VISITOR_IMAGE_MAX_SIDE,
        height: VISITOR_IMAGE_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { jpeg: out.data, width: out.info.width, height: out.info.height };
  } catch (err) {
    if (err instanceof VisitorImageError) throw err;
    // sharp says "Input buffer contains unsupported image format" for a non-image.
    const unsupported = err instanceof Error && /unsupported image format|Input buffer/i.test(err.message);
    throw new VisitorImageError(unsupported ? 'unsupported' : 'corrupt');
  }
}
