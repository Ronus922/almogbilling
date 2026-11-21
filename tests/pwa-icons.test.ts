import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// iPhone Home Screen install (21/11/2026). iOS asks the SITE ROOT for
// /apple-touch-icon.png and /apple-touch-icon-precomposed.png whenever the page
// gives it no <link rel="apple-touch-icon"> — a page that failed to load, for
// one. Both are byte-identical copies of the opaque 180×180 icon-180.png that
// the <link> names, so the icon is the same whichever way iOS finds it.

const pub = (f: string) => join(process.cwd(), 'public', f);

/** Width, height and colour type, read from the PNG header itself. */
function pngInfo(buf: Buffer): { w: number; h: number; colorType: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25]! };
}

describe('PWA icons', () => {
  it('icon-180.png is a 180×180 PNG', () => {
    const { w, h } = pngInfo(readFileSync(pub('icon-180.png')));
    expect([w, h]).toEqual([180, 180]);
  });
  it.each(['apple-touch-icon.png', 'apple-touch-icon-precomposed.png'])('%s at the root is the same bytes as icon-180.png', (f) => {
    expect(readFileSync(pub(f)).equals(readFileSync(pub('icon-180.png')))).toBe(true);
  });
  it('every icon of the manifest exists, and the manifest starts and scopes at /, standalone', () => {
    const m = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8')) as {
      start_url: string; scope: string; display: string; icons: { src: string }[];
    };
    expect([m.start_url, m.scope, m.display]).toEqual(['/', '/', 'standalone']);
    for (const i of m.icons) expect(existsSync(pub(i.src.replace(/^\//, ''))), i.src).toBe(true);
  });
});
