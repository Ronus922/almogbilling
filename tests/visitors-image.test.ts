import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { heicPixels, isHeic, MAX_HEIC_PIXELS, prepareVisitorImage, VisitorImageError } from '@/lib/visitors/image';

// What every photo goes through before the OCR and before Storage: one upright
// JPEG, at most 1600px, with no metadata. The HEIC fixture is a 96×64 synthetic
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

