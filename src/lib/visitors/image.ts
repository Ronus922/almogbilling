import 'server-only';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import heicConvert from 'heic-convert';
import { logger } from '@/lib/logger';
import {
  VISITOR_IMAGE_FALLBACK_SIDE, VISITOR_IMAGE_MAX_SIDE, VISITOR_IMAGE_QUALITIES, VISITOR_IMAGE_TARGET_BYTES,
} from './model';

// One entry point for every photo of a document: whatever the phone sent
// (JPEG, PNG, WebP, HEIC / HEIF) comes out as ONE shape — upright, at most
// 1600px on its long side, with no metadata, and as light as it can be while
// every letter and digit stays readable (compressVisitorImage: a WebP of at
// most ~300KB). The OCR reads that, the Storage keeps that, the screen shows
// that — ONE encode, never two.
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

/** Runs `fn`, turning anything sharp throws into the typed error the routes understand. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VisitorImageError) throw err;
    // sharp says "Input buffer contains unsupported image format" for a non-image.
    const unsupported = err instanceof Error && /unsupported image format|Input buffer/i.test(err.message);
    throw new VisitorImageError(unsupported ? 'unsupported' : 'corrupt');
  }
}

/** Validates the upload and decodes what sharp cannot: a HEIC becomes a JPEG buffer, everything else
 *  must be one of the allowed formats. The result is what `upright()` reads. */
async function openSource(input: Buffer): Promise<Buffer> {
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

  const format = await guarded(async () => (await sharp(source, { failOn: 'error' }).metadata()).format);
  if (!format || !ALLOWED_FORMATS.has(format)) throw new VisitorImageError('unsupported');
  return source;
}

/** The common front of every output: orientation applied (rotate() with no argument also drops the
 *  tag, so the photo is upright for the OCR and for every viewer), shrunk to `side` on its long
 *  side — never enlarged — and flattened onto white (JPEG and the OCR have no alpha). Nothing is
 *  carried over from the input's metadata: sharp writes none unless asked. */
function upright(source: Buffer, side: number): Sharp {
  return sharp(source, { failOn: 'error', limitInputPixels: 120_000_000 })
    .rotate()
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' });
}

/** An upright JPEG of at most `maxSide` (default 1600px) — the PREVIEW the crop step draws when the
 *  browser could not open the file itself (a HEIC outside Safari). Not the stored form: see
 *  compressVisitorImage. */
export async function prepareVisitorImage(input: Buffer, maxSide: number = VISITOR_IMAGE_MAX_SIDE): Promise<PreparedImage> {
  const source = await openSource(input);
  return guarded(async () => {
    const out = await upright(source, maxSide).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { jpeg: out.data, width: out.info.width, height: out.info.height };
  });
}

// ── The stored form (09/11/2026) ──────────────────────────────────────────────

export interface CompressedImage {
  bytes: Buffer;
  format: 'webp' | 'jpeg';
  contentType: 'image/webp' | 'image/jpeg';
  /** Without the dot — the object key's extension. */
  ext: 'webp' | 'jpg';
  width: number;
  height: number;
  /** The quality the ladder stopped at; null for a photo that arrived already final. */
  quality: number | null;
}

const asCompressed = (data: Buffer, format: 'webp' | 'jpeg', width: number, height: number, quality: number | null): CompressedImage => ({
  bytes: data,
  format,
  contentType: format === 'webp' ? 'image/webp' : 'image/jpeg',
  ext: format === 'webp' ? 'webp' : 'jpg',
  width,
  height,
  quality,
});

/** The biggest file `acceptFinalWebp` waves through untouched. The ladder aims at 300KB and accepts
 *  its floor (1280px, quality 60) even when that is heavier, so a final photo can legitimately weigh
 *  more than the target; this is the ceiling of "legitimately". */
const MAX_FINAL_BYTES = 1_000_000;

/** True for a WebP that is EXACTLY one plain lossy bitstream: `RIFF` size matching the file (nothing
 *  appended), a single `VP8 ` chunk filling it. No VP8X header, so no alpha, ICC profile, EXIF, XMP or
 *  animation can be hiding in it — sharp's encoder writes exactly this for a flattened photo. */
function isPlainWebp(buf: Buffer): boolean {
  if (buf.length < 30 || buf.length > MAX_FINAL_BYTES) return false;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return false;
  if (buf.readUInt32LE(4) + 8 !== buf.length) return false;
  if (buf.toString('latin1', 12, 16) !== 'VP8 ') return false;
  const size = buf.readUInt32LE(16);
  return 20 + size + (size & 1) === buf.length;
}

/** A photo that already left the OCR step in its final shape (the save step posts it back) is stored
 *  as it came — "one processing, not two" — but only after it proves to be exactly that shape:
 *  a plain WebP, within the size bounds, that decodes. Anything else returns null and goes through
 *  the whole pipeline instead, so what reaches Storage is always an image this server has verified. */
async function acceptFinalWebp(input: Buffer): Promise<CompressedImage | null> {
  if (!isPlainWebp(input)) return null;
  try {
    const img = sharp(input, { failOn: 'error', limitInputPixels: 120_000_000 });
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (meta.format !== 'webp' || (meta.pages ?? 1) !== 1 || w === 0 || h === 0 || Math.max(w, h) > VISITOR_IMAGE_MAX_SIDE) return null;
    await sharp(input, { failOn: 'error', limitInputPixels: 120_000_000 }).stats(); // forces a full decode
    return asCompressed(input, 'webp', w, h, null);
  } catch {
    return null;
  }
}

/**
 * The one encode of a document photo: orientation applied → shrunk to 1600px on the long side →
 * every piece of metadata dropped → WebP quality 80. If that weighs more than 300KB the quality steps
 * down (70, 60); if it still does, the picture is shrunk to 1280px and the same steps run again.
 * NEVER below quality 60 or 1280px — being able to read the document comes before its weight, so the
 * floor is accepted even when it is heavier than the target.
 *
 * If WebP cannot be written (it can in every sharp build we run; this is the net under it), the same
 * ladder runs as JPEG. A photo that is already final (see acceptFinalWebp) is returned as it is.
 */
export async function compressVisitorImage(input: Buffer): Promise<CompressedImage> {
  const final = await acceptFinalWebp(input);
  if (final) return final;

  const source = await openSource(input);
  let format: 'webp' | 'jpeg' = 'webp';
  let last: CompressedImage | null = null;

  for (const side of [VISITOR_IMAGE_MAX_SIDE, VISITOR_IMAGE_FALLBACK_SIDE]) {
    const pipe = upright(source, side);
    for (const quality of VISITOR_IMAGE_QUALITIES) {
      let out: { data: Buffer; info: OutputInfo };
      if (format === 'webp') {
        try {
          out = await guarded(() => pipe.clone().webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true }));
        } catch (err) {
          // A broken INPUT is not a missing encoder: the JPEG attempt below reads the same pixels and
          // fails the same way, which is what the caller must see.
          logger.warn('[visitors image] webp encode failed, falling back to jpeg', { name: err instanceof Error ? err.name : 'unknown' });
          format = 'jpeg';
          out = await guarded(() => pipe.clone().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
        }
      } else {
        out = await guarded(() => pipe.clone().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
      }
      last = asCompressed(out.data, format, out.info.width, out.info.height, quality);
      if (out.data.length <= VISITOR_IMAGE_TARGET_BYTES) return last;
    }
  }
  // The floor (1280px, lowest quality) still weighs more than the target: keep it, and say so.
  logger.warn('[visitors image] over the target weight at the floor', { bytes: last!.bytes.length, side: Math.max(last!.width, last!.height) });
  return last!;
}
