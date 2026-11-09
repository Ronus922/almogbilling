import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { compressVisitorImage, heicPixels, isHeic, MAX_HEIC_PIXELS, prepareVisitorImage, VisitorImageError } from '@/lib/visitors/image';
import { VISITOR_IMAGE_TARGET_BYTES } from '@/lib/visitors/model';
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// What every photo goes through before the OCR and before Storage: one upright
// image, at most 1600px, with no metadata — a progressive JPEG of at most ~300KB (compressVisitorImage;
// JPEG and not WebP: it has to open on any computer and travel to outside parties);
// prepareVisitorImage is only the crop step's JPEG preview of a file the browser cannot draw. The HEIC fixture is a 96×64 synthetic
// gradient made with pillow-heif — no person, no document — so it can live in a
// public repo.

const HEIC = readFileSync(join(__dirname, 'fixtures', 'synthetic-96x64.heic'));

async function jpegWithExif(w: number, h: number, orientation: number): Promise<Buffer> {
  // withExif() cannot set the orientation tag (sharp pins it to 1); withMetadata can.
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N' } })
    .withMetadata({ orientation })
    .toBuffer();
  // The strip test below is only meaningful if the input really carries both.
  const meta = await sharp(buf).metadata();
  if (meta.orientation !== orientation || !buf.includes(Buffer.from('TestPhone'))) throw new Error('test fixture lost its EXIF');
  return buf;
}

describe('prepareVisitorImage', () => {
  it('shrinks a big photo so its long side is 1600px, keeping the aspect ratio', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    const out = await prepareVisitorImage(big);
    expect(Math.max(out.width, out.height)).toBe(1600);
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
    expect((await sharp(out.jpeg).metadata()).format).toBe('jpeg');
  });

  it('never enlarges a small photo', async () => {
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#aaaaaa' } }).png().toBuffer();
    const out = await prepareVisitorImage(small);
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  it('the crop step\'s preview can be asked for 2000px (the upload size) instead', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    expect((await prepareVisitorImage(big, 2000)).width).toBe(2000);
  });

  it('applies the EXIF orientation (a phone held sideways comes out upright)', async () => {
    const sideways = await jpegWithExif(800, 400, 6); // rotated 90°: displays as 400×800
    const out = await prepareVisitorImage(sideways);
    expect([out.width, out.height]).toEqual([400, 800]);
  });

  it('strips ALL metadata — GPS and device model never reach Storage', async () => {
    const out = await prepareVisitorImage(await jpegWithExif(800, 600, 1));
    const meta = await sharp(out.jpeg).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.jpeg.includes(Buffer.from('TestPhone'))).toBe(false);
  });

  it('accepts PNG and WebP and always answers JPEG', async () => {
    for (const fmt of ['png', 'webp'] as const) {
      const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00ff00' } })[fmt]().toBuffer();
      expect((await sharp((await prepareVisitorImage(buf)).jpeg).metadata()).format).toBe('jpeg');
    }
  });

  it('flattens transparency onto white (a JPEG has no alpha)', async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const { data } = await sharp((await prepareVisitorImage(png)).jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('decodes a real HEIC (an iPhone photo) into a JPEG', async () => {
    expect(isHeic(HEIC)).toBe(true);
    const out = await prepareVisitorImage(HEIC);
    expect([out.width, out.height]).toEqual([96, 64]);
    expect((await sharp(out.jpeg).metadata()).format).toBe('jpeg');
  });

  it('empty input, a non-image and a truncated HEIC are refused with a typed error', async () => {
    await expect(prepareVisitorImage(Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty' });
    await expect(prepareVisitorImage(Buffer.from('this is not a picture at all'))).rejects.toBeInstanceOf(VisitorImageError);
    await expect(prepareVisitorImage(HEIC.subarray(0, 120))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('isHeic recognises the HEIC brands and nothing else', () => {
    expect(isHeic(HEIC)).toBe(true);
    expect(isHeic(Buffer.from('....ftypheixrest-of-file'))).toBe(true);
    expect(isHeic(Buffer.from('....ftypmif1rest-of-file'))).toBe(true);
    expect(isHeic(Buffer.from('....ftypisomrest-of-file'))).toBe(false); // an MP4
    expect(isHeic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isHeic(Buffer.alloc(4))).toBe(false);
  });
});

describe('the guards in front of the decoder', () => {
  it('reads the declared size from the HEIC header (ispe), not from the pixels', () => {
    expect(heicPixels(HEIC)).toBe(96 * 64);
  });

  it('a HEIC whose header declares a huge picture is refused BEFORE it is decoded', async () => {
    const forged = Buffer.from(HEIC);
    const at = forged.indexOf('ispe', 4, 'latin1');
    expect(at).toBeGreaterThan(0);
    forged.writeUInt32BE(30000, at + 8);
    forged.writeUInt32BE(30000, at + 12);
    expect(heicPixels(forged)).toBeGreaterThan(MAX_HEIC_PIXELS);
    // 'too_large' is only ever thrown by the check in front of the decoder, so seeing it
    // proves the WASM decode never started.
    await expect(prepareVisitorImage(forged)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('an ispe tag planted outside the real box tree does not count (no false alarm, no bypass)', () => {
    const planted = Buffer.concat([HEIC, Buffer.from('....ispe\0\0\0\0', 'latin1'), Buffer.alloc(8, 0xff)]);
    expect(heicPixels(planted)).toBe(96 * 64);
  });

  it('a HEIC that declares no size at all is not trusted', async () => {
    const noIspe = Buffer.from(HEIC);
    let at = noIspe.indexOf('ispe', 4, 'latin1');
    while (at !== -1) { noIspe.write('xxxx', at, 'latin1'); at = noIspe.indexOf('ispe', 4, 'latin1'); }
    expect(heicPixels(noIspe)).toBe(0);
    await expect(prepareVisitorImage(noIspe)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')],
    ['GIF', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
  ])('%s is not a photo of a document → unsupported', async (_n, buf) => {
    await expect(prepareVisitorImage(buf)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('TIFF is refused too', async () => {
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).tiff().toBuffer();
    await expect(prepareVisitorImage(tiff)).rejects.toMatchObject({ code: 'unsupported' });
  });
});



// ── The stored form: one JPEG, as light as it can be while staying readable ──

/** A photo-like picture: smooth gradients plus fine text-like detail and sensor noise. */
async function photoLike(w: number, h: number, noise: number): Promise<Buffer> {
  const bars = Array.from({ length: 14 }, (_, i) => `<rect x="${w * 0.1}" y="${h * (0.12 + i * 0.06)}" width="${w * (0.3 + (i % 5) * 0.1)}" height="${h * 0.018}" fill="#111"/>`).join('');
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8e4d8"/><stop offset="1" stop-color="#9aa7b8"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${bars}</svg>`;
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  if (noise === 0) return sharp(base).jpeg({ quality: 90 }).toBuffer();
  const grain = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: noise } } }).png().toBuffer();
  return sharp(base).composite([{ input: grain, blend: 'overlay' }]).jpeg({ quality: 90 }).toBuffer();
}

/** Splices one extra segment (marker + payload) in right after SOI, the way a tool that tags a JPEG would. */
function withSegment(jpeg: Buffer, marker: number, payload: Buffer): Buffer {
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

// These build 3-4 megapixel noise photos and encode them up to eight times (mozjpeg is slower than the
// WebP encoder it replaced): several seconds on a quiet machine, over vitest's 5s default on a loaded
// one. The limit is the test's, not the code's.
describe('compressVisitorImage', { timeout: 60_000 }, () => {
  it('a phone-sized photo (several MB) comes out as one progressive JPEG under 300KB, at most 1600px, no metadata', async () => {
    const original = await photoLike(3000, 2250, 18);
    expect(original.length).toBeGreaterThan(1_000_000); // the input really is a heavy photo
    const out = await compressVisitorImage(original);
    expect(out.format).toBe('jpeg');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.ext).toBe('jpg');
    expect(out.bytes.length).toBeLessThanOrEqual(VISITOR_IMAGE_TARGET_BYTES);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.isProgressive).toBe(true);
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1600);
    expect([out.width, out.height]).toEqual([meta.width, meta.height]);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    // A real JPEG file: SOI first, EOI last.
    expect([...out.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it('starts at quality 82 and 1600px: an easy photo is not degraded for nothing', async () => {
    const out = await compressVisitorImage(await photoLike(1200, 800, 0));
    expect(out.quality).toBe(82);
    expect(Math.max(out.width, out.height)).toBe(1200); // never enlarged, never shrunk without need
  });

  it('steps the quality down in sixes (82, 76, 70, 64), and shrinks to 1280px only when 64 is not enough', async () => {
    // Heavy grain: every step at 1600px stays over 300KB, so the picture drops to 1280px.
    const out = await compressVisitorImage(await photoLike(4000, 3000, 60));
    expect(out.format).toBe('jpeg');
    expect([82, 76, 70, 64]).toContain(out.quality);
    expect(Math.max(out.width, out.height)).toBeGreaterThanOrEqual(1280);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1600);
    if (Math.max(out.width, out.height) === 1600) expect(out.bytes.length).toBeLessThanOrEqual(VISITOR_IMAGE_TARGET_BYTES);
  });

  it('NEVER goes below quality 64 or 1280px: readability beats weight, the floor is kept even when heavy', async () => {
    // Pure white-noise: nothing fits 300KB. The result is the floor — 1280px at quality 64 — and it stays heavy.
    // (1600×1200: close enough to 1280px that shrinking cannot average the noise away.)
    const raw = Buffer.alloc(1600 * 1200 * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(Math.random() * 256);
    const noise = await sharp(raw, { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const out = await compressVisitorImage(noise);
    expect(out.quality).toBe(64);
    expect(Math.max(out.width, out.height)).toBe(1280);
    expect(out.bytes.length).toBeGreaterThan(VISITOR_IMAGE_TARGET_BYTES);
  });

  it('applies the EXIF orientation and strips every tag — GPS and device model never reach Storage', async () => {
    const sideways = await jpegWithExif(1600, 800, 6);
    const out = await compressVisitorImage(sideways);
    expect([out.width, out.height]).toEqual([800, 1600]);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.bytes.includes(Buffer.from('TestPhone'))).toBe(false);
    expect(out.bytes.includes(Buffer.from('GPS'))).toBe(false);
  });

  it('flattens transparency onto white, and never enlarges a small photo', async () => {
    const png = await sharp({ create: { width: 64, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await compressVisitorImage(png);
    expect([out.width, out.height]).toEqual([64, 40]);
    const { data } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('decodes a real HEIC (an iPhone photo) into the stored JPEG', async () => {
    const out = await compressVisitorImage(HEIC);
    expect(out.format).toBe('jpeg');
    expect([out.width, out.height]).toEqual([96, 64]);
  });

  it('still accepts a WebP or PNG as INPUT (a gallery photo) — it just never stores one', async () => {
    const webp = await sharp(await photoLike(1000, 700, 0)).webp({ quality: 80 }).toBuffer();
    const out = await compressVisitorImage(webp);
    expect(out.format).toBe('jpeg');
    expect((await sharp(out.bytes).metadata()).format).toBe('jpeg');
  });

  it('refuses what is not a photo, with the same typed errors', async () => {
    await expect(compressVisitorImage(Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty' });
    await expect(compressVisitorImage(Buffer.from('not a picture'))).rejects.toBeInstanceOf(VisitorImageError);
    await expect(compressVisitorImage(HEIC.subarray(0, 120))).rejects.toMatchObject({ code: 'corrupt' });
    await expect(compressVisitorImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'))).rejects.toMatchObject({ code: 'unsupported' });
  });

  describe('a photo that already came out of this pipeline (the save step posts the OCR step\'s bytes back)', () => {
    it('is stored AS IT CAME — one encode, not two', async () => {
      const first = await compressVisitorImage(await photoLike(3000, 2000, 12));
      const again = await compressVisitorImage(first.bytes);
      expect(again.bytes.equals(first.bytes)).toBe(true);
      expect(again.format).toBe('jpeg');
      expect([again.width, again.height]).toEqual([first.width, first.height]);
      expect(again.quality).toBeNull(); // not re-encoded
    });

    it('is NOT trusted when anything is appended to it — the whole pipeline runs and the extra bytes are gone', async () => {
      const first = await compressVisitorImage(await photoLike(1600, 1000, 0));
      const tainted = Buffer.concat([first.bytes, Buffer.from('<script>alert(1)</script>')]);
      const out = await compressVisitorImage(tainted);
      expect(out.bytes.equals(tainted)).toBe(false);
      expect(out.bytes.includes(Buffer.from('<script>'))).toBe(false);
      expect(out.quality).not.toBeNull();
    });

    it('is NOT trusted when it carries EXIF — re-encoded, the tag is gone', async () => {
      const withExif = await sharp(await photoLike(800, 600, 0)).withExif({ IFD0: { Make: 'TestPhone' } }).jpeg({ quality: 80, progressive: true }).toBuffer();
      expect(withExif.includes(Buffer.from('TestPhone'))).toBe(true); // the fixture really carries it
      const out = await compressVisitorImage(withExif);
      expect(out.bytes.equals(withExif)).toBe(false);
      expect(out.bytes.includes(Buffer.from('TestPhone'))).toBe(false);
      expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
    });

    it('is NOT trusted when it carries a colour profile, an XMP packet or a comment — each is a segment the pipeline strips', async () => {
      const clean = (await compressVisitorImage(await photoLike(800, 600, 0))).bytes;
      const cases: [string, Buffer][] = [
        ['ICC profile (APP2)', withSegment(clean, 0xe2, Buffer.from('ICC_PROFILE\0\x01\x01 tag-in-profile'))],
        ['XMP (APP1)', withSegment(clean, 0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>tag-in-xmp</x:xmpmeta>'))],
        ['comment (COM)', withSegment(clean, 0xfe, Buffer.from('tag-in-comment'))],
        ['Adobe tag (APP14)', withSegment(clean, 0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01'))],
      ];
      for (const [label, tagged] of cases) {
        const out = await compressVisitorImage(tagged);
        expect(out.bytes.equals(tagged), label).toBe(false);
        expect(out.bytes.includes(Buffer.from('tag-in')), label).toBe(false);
        expect(out.quality, label).not.toBeNull(); // went through the ladder
      }
    });

    it('is NOT trusted when a payload hides in extra segments, in junk before a marker, or in repeated tables', async () => {
      const clean = (await compressVisitorImage(await photoLike(800, 600, 0))).bytes;
      const marker = Buffer.from('HIDDEN-PAYLOAD-0123456789');
      const jfifHead = Buffer.concat([Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]); // canonical: 14 bytes, no thumbnail
      const firstSos = clean.indexOf(Buffer.from([0xff, 0xda]));
      const afterScan = clean.indexOf(Buffer.from([0xff, 0xc4]), firstSos + 2); // the next table after the first scan's data
      expect(afterScan).toBeGreaterThan(firstSos);
      const cases: [string, Buffer][] = [
        ['APP0 with a long tail after a JFIF head', withSegment(clean, 0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.alloc(40_000, 0x41), marker]))],
        ['an APP0 whose head is canonical but carries a thumbnail', withSegment(clean, 0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 2, 2]), marker]))],
        ['two JFIF tags', withSegment(withSegment(clean, 0xe0, jfifHead), 0xe0, jfifHead)],
        ['junk right before the final EOI', Buffer.concat([clean.subarray(0, clean.length - 2), Buffer.alloc(5_000, 0x41), marker, Buffer.from([0xff, 0xd9])])],
        ['junk between two scans', Buffer.concat([clean.subarray(0, afterScan), Buffer.alloc(5_000, 0x41), marker, clean.subarray(afterScan)])],
        ['a pile of quantisation tables', [1, 2, 3, 4, 5].reduce((acc) => withSegment(acc, 0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), clean)],
        ['an oversized quantisation table', withSegment(clean, 0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(900, 1), marker]))],
      ];
      for (const [label, crafted] of cases) {
        // Either the decoder refuses the doctored file outright (a table that is not a table), or the whole
        // pipeline runs and the payload is gone - what must NEVER happen is storing it as it came.
        const out = await compressVisitorImage(crafted).catch((err: unknown) => {
          expect(err, label).toBeInstanceOf(VisitorImageError);
          return null;
        });
        if (!out) continue;
        expect(out.bytes.equals(crafted), label).toBe(false);
        expect(out.quality, label).not.toBeNull(); // went through the ladder
        expect(out.bytes.includes(Buffer.from('HIDDEN-PAYLOAD')), label).toBe(false);
        expect(out.bytes.length, label).toBeLessThanOrEqual(VISITOR_IMAGE_TARGET_BYTES);
      }
    });

    it('accepts ONE canonical JFIF tag right after SOI, as it came', async () => {
      const clean = (await compressVisitorImage(await photoLike(800, 600, 0))).bytes;
      const withJfif = withSegment(clean, 0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]));
      const out = await compressVisitorImage(withJfif);
      expect(out.bytes.equals(withJfif)).toBe(true);
      expect(out.quality).toBeNull();
    });

    it('is NOT trusted when it is a baseline JPEG (a browser canvas, a camera) — only this pipeline\'s progressive output is final', async () => {
      const baseline = await sharp(await photoLike(1200, 800, 0)).jpeg({ quality: 88, progressive: false }).toBuffer();
      expect((await sharp(baseline).metadata()).isProgressive).toBe(false);
      const out = await compressVisitorImage(baseline);
      expect(out.bytes.equals(baseline)).toBe(false);
      expect(out.quality).toBe(82);
      expect((await sharp(out.bytes).metadata()).isProgressive).toBe(true);
    });

    it('is NOT trusted when it is bigger than 1600px — brought down to 1600px', async () => {
      const big = await sharp(await photoLike(2400, 1600, 0)).jpeg({ quality: 80, progressive: true }).toBuffer();
      const out = await compressVisitorImage(big);
      expect(Math.max(out.width, out.height)).toBe(1600);
      expect(out.bytes.equals(big)).toBe(false);
    });

    it('a truncated final photo is never stored as it is — a complete JPEG comes out', async () => {
      const first = await compressVisitorImage(await photoLike(1600, 1000, 8));
      const cut = first.bytes.subarray(0, Math.floor(first.bytes.length / 2));
      try {
        const out = await compressVisitorImage(cut);
        expect(out.bytes.equals(cut)).toBe(false);
        expect([...out.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
      } catch (err) {
        expect(err).toBeInstanceOf(VisitorImageError); // or refused outright - both keep a half photo out
      }
    });

    it('is NOT trusted when a marker is planted inside the compressed data after the picture — appended after EOI', async () => {
      const first = await compressVisitorImage(await photoLike(900, 600, 0));
      const afterEoi = Buffer.concat([first.bytes, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xd9])]);
      const out = await compressVisitorImage(afterEoi);
      expect(out.bytes.equals(afterEoi)).toBe(false);
      expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
    });
  });
});
