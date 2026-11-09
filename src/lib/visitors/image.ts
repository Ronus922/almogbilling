import 'server-only';
import sharp, { type Sharp } from 'sharp';
import heicConvert from 'heic-convert';
import { logger } from '@/lib/logger';
import {
  VISITOR_IMAGE_FALLBACK_SIDE, VISITOR_IMAGE_MAX_SIDE, VISITOR_IMAGE_QUALITIES, VISITOR_IMAGE_TARGET_BYTES,
} from './model';

// One entry point for every photo of a document: whatever the phone sent
// (JPEG, PNG, WebP, HEIC / HEIF) comes out as ONE shape — upright, at most
// 1600px on its long side, with no metadata, and as light as it can be while
// every letter and digit stays readable (compressVisitorImage: a progressive
// JPEG of at most ~300KB). The OCR reads that, the Storage keeps that, the
// screen shows that — ONE encode, never two. JPEG and not WebP on purpose: the
// photo of a document has to open on any computer and be handed to outside
// parties (police, a court) as an ordinary file.
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
 *  browser could not open the file itself (a HEIC outside Safari). Not the stored form (that one is
 *  weighed against 300KB and verified before it is kept): see compressVisitorImage. */
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
  format: 'jpeg';
  contentType: 'image/jpeg';
  /** Without the dot — the object key's extension. */
  ext: 'jpg';
  width: number;
  height: number;
  /** The quality the ladder stopped at; null for a photo that arrived already final. */
  quality: number | null;
}

const asCompressed = (data: Buffer, width: number, height: number, quality: number | null): CompressedImage => ({
  bytes: data,
  format: 'jpeg',
  contentType: 'image/jpeg',
  ext: 'jpg',
  width,
  height,
  quality,
});

/** The biggest file `acceptFinalJpeg` waves through untouched. The ladder aims at 300KB and accepts
 *  its floor (1280px, quality 64) even when that is heavier, so a final photo can legitimately weigh
 *  more than the target; this is the ceiling of "legitimately". */
const MAX_FINAL_BYTES = 1_000_000;

/** JPEG markers the walker below knows. */
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const DQT = 0xdb;
const DHT = 0xc4;
const DRI = 0xdd;
const SOF_PROGRESSIVE = 0xc2;

/** The most of each segment a plain photo has, and the longest each may be. A segment inside these
 *  limits cannot carry a payload worth hiding: sharp's own output has two DQT (luma, chroma), a handful
 *  of DHT (one set per scan) and no APP0 at all, so the limits sit well above it and far below "room
 *  for a file". */
const MAX_DQT = 4;
const MAX_DQT_LENGTH = 2 + 4 * (1 + 128); // four 16-bit tables
const MAX_DHT = 64;
const MAX_DHT_LENGTH = 2 + 4 * (1 + 16 + 256); // four tables of 256 symbols
const MAX_SCANS = 64;

/** True for a JPEG that is EXACTLY a progressive image and nothing else: it opens with SOI, every segment
 *  before the scans is a quantisation / Huffman table, a restart interval, the one frame header, or at
 *  most ONE canonical 16-byte JFIF tag right after SOI (no thumbnail) - each within a small size limit, so
 *  no EXIF, XMP, ICC profile (APP1/APP2), Adobe tag or comment can be hiding in it and no table can be
 *  stuffed with a payload - and it ends with EOI as the very last two bytes, so nothing is appended after
 *  the picture. This is what sharp's encoder writes for a flattened photo with `progressive: true`; a
 *  baseline JPEG (a browser canvas, a camera) is never "final", it goes through the ladder. The walk is
 *  over MARKERS, not a search for a word, so a tag planted inside the compressed data is not mistaken for
 *  a segment. Bytes that only LOOK like entropy data (junk before a marker) are caught by the decoder,
 *  which acceptFinalJpeg runs with `failOn: 'warning'`. */
function isPlainJpeg(buf: Buffer): boolean {
  const n = buf.length;
  if (n < 4 || n > MAX_FINAL_BYTES) return false;
  if (buf[0] !== 0xff || buf[1] !== SOI) return false;
  let at = 2;
  let frame = false;
  let scans = 0;
  let dqt = 0;
  let dht = 0;
  let dri = 0;
  while (at + 2 <= n) {
    if (buf[at] !== 0xff) return false;
    const marker = buf[at + 1]!;
    if (marker === EOI) return frame && scans > 0 && at + 2 === n;
    // Every other marker allowed here carries a length (which counts its own two bytes).
    if (at + 4 > n) return false;
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > n) return false;
    if (marker === APP0) {
      // One canonical JFIF header, straight after SOI: 'JFIF\0', version, units, densities, and a 0×0 thumbnail.
      if (at !== 2 || length !== 16 || buf.toString('latin1', at + 4, at + 9) !== 'JFIF\0' || buf[at + 16] !== 0 || buf[at + 17] !== 0) return false;
    } else if (marker === SOS) {
      if (!frame || length < 8 || length > 14 || ++scans > MAX_SCANS) return false;
    } else if (marker === DQT) {
      if (length > MAX_DQT_LENGTH || ++dqt > MAX_DQT) return false;
    } else if (marker === DHT) {
      if (length > MAX_DHT_LENGTH || ++dht > MAX_DHT) return false;
    } else if (marker === DRI) {
      if (length !== 4 || ++dri > 1) return false;
    } else if (marker === SOF_PROGRESSIVE) {
      if (frame || length < 11 || length > 20) return false; // one frame only, one to four components
      frame = true;
    } else {
      return false; // APP1..APP15, COM, a baseline / lossless / arithmetic frame, restart markers, …
    }
    at += 2 + length;
    if (marker === SOS) {
      // The entropy-coded data: runs until the next real marker. 0xFF 0x00 is a stuffed data byte,
      // 0xFF 0xD0..D7 a restart, 0xFF 0xFF a fill byte; anything else is the next segment.
      while (at < n) {
        if (buf[at] === 0xff) {
          const next = buf[at + 1];
          if (next === undefined) return false;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { at += 2; continue; }
          if (next === 0xff) { at += 1; continue; }
          break;
        }
        at++;
      }
    }
  }
  return false; // ran off the end without an EOI
}

/** A photo that already left the OCR step in its final shape (the save step posts it back) is stored
 *  as it came — "one processing, not two" — but only after it proves to be exactly that shape:
 *  a plain progressive JPEG, within the size bounds, that decodes end to end. Anything else returns
 *  null and goes through the whole pipeline instead, so what reaches Storage is always an image this
 *  server has verified. */
async function acceptFinalJpeg(input: Buffer): Promise<CompressedImage | null> {
  if (!isPlainJpeg(input)) return null;
  try {
    // failOn 'warning': libjpeg reports junk between scans or before the final EOI as a warning, and a photo
    // that is "final" has none.
    const meta = await sharp(input, { failOn: 'warning', limitInputPixels: 120_000_000 }).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (meta.format !== 'jpeg' || w === 0 || h === 0 || Math.max(w, h) > VISITOR_IMAGE_MAX_SIDE) return null;
    await sharp(input, { failOn: 'warning', limitInputPixels: 120_000_000 }).stats(); // forces a full decode
    return asCompressed(input, w, h, null);
  } catch {
    return null;
  }
}

/**
 * The one encode of a document photo: orientation applied → shrunk to 1600px on the long side →
 * every piece of metadata dropped → progressive JPEG (mozjpeg when the build has it) at quality 82.
 * If that weighs more than 300KB the quality steps down by 6 (76, 70, 64); if it still does, the
 * picture is shrunk to 1280px and the same steps run again. NEVER below quality 64 or 1280px —
 * being able to read the document comes before its weight, so the floor is accepted even when it is
 * heavier than the target.
 *
 * A photo that is already final (see acceptFinalJpeg) is returned as it is.
 */
export async function compressVisitorImage(input: Buffer): Promise<CompressedImage> {
  const final = await acceptFinalJpeg(input);
  if (final) return final;

  const source = await openSource(input);
  let last: CompressedImage | null = null;

  for (const side of [VISITOR_IMAGE_MAX_SIDE, VISITOR_IMAGE_FALLBACK_SIDE]) {
    const pipe = upright(source, side);
    for (const quality of VISITOR_IMAGE_QUALITIES) {
      const out = await guarded(() => pipe.clone().jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer({ resolveWithObject: true }));
      last = asCompressed(out.data, out.info.width, out.info.height, quality);
      if (out.data.length <= VISITOR_IMAGE_TARGET_BYTES) return last;
    }
  }
  // The floor (1280px, lowest quality) still weighs more than the target: keep it, and say so.
  logger.warn('[visitors image] over the target weight at the floor', { bytes: last!.bytes.length, side: Math.max(last!.width, last!.height) });
  return last!;
}
