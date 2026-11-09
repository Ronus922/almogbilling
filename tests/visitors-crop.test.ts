import { describe, it, expect } from 'vitest';
import sharp, { type OverlayOptions } from 'sharp';
import {
  adjustFor, clampRect, defaultCropRect, fitScale, fullRect, HANDLES, MAX_ZOOM, minCropSide, moveRect,
  NO_ADJUST, outputSize, rectOnStage, resizeRect, resolveView, zoomAt, type Handle, type Rect,
} from '@/lib/visitors/crop';
import { detectDocumentRect } from '@/lib/visitors/cropDetect';

// The crop frame's arithmetic and the document finder ("חיתוך התעודה", 09/11/2026).
// The editor component only wires pointers to these functions; the browser flow is
// proved in e2e/visitors.spec.ts.

describe('the crop frame', () => {
  it('starts as 85% of the picture, centred', () => {
    expect(defaultCropRect(4000, 3000)).toEqual({ x: 300, y: 225, w: 3400, h: 2550 });
    expect(fullRect(800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('never leaves the picture and never gets smaller than the minimum', () => {
    const min = minCropSide(1000, 800);
    expect(min).toBe(40); // 5% of the short side
    expect(clampRect({ x: -50, y: 900, w: 5000, h: 3 }, 1000, 800, min)).toEqual({ x: 0, y: 760, w: 1000, h: 40 });
    expect(minCropSide(100, 100)).toBe(32);
    expect(minCropSide(20, 500)).toBe(20); // a picture smaller than the floor
  });

  it('moves as a whole and stops at the edges', () => {
    const r: Rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(moveRect(r, 50, -20, 1000, 800)).toEqual({ x: 150, y: 80, w: 400, h: 300 });
    expect(moveRect(r, -500, 9999, 1000, 800)).toEqual({ x: 0, y: 500, w: 400, h: 300 });
  });

  it.each<[Handle, [number, number], Rect]>([
    ['nw', [30, 20], { x: 130, y: 120, w: 370, h: 280 }],
    ['n', [30, 20], { x: 100, y: 120, w: 400, h: 280 }],
    ['ne', [30, 20], { x: 100, y: 120, w: 430, h: 280 }],
    ['e', [30, 20], { x: 100, y: 100, w: 430, h: 300 }],
    ['se', [30, 20], { x: 100, y: 100, w: 430, h: 320 }],
    ['s', [30, 20], { x: 100, y: 100, w: 400, h: 320 }],
    ['sw', [30, 20], { x: 130, y: 100, w: 370, h: 320 }],
    ['w', [30, 20], { x: 130, y: 100, w: 370, h: 300 }],
  ])('the %s handle moves only its own edges', (handle, [dx, dy], want) => {
    expect(resizeRect({ x: 100, y: 100, w: 400, h: 300 }, handle, dx, dy, 1000, 800, 40)).toEqual(want);
  });

  it('a handle cannot cross the opposite edge, leave the picture, or squash below the minimum', () => {
    const r: Rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(resizeRect(r, 'e', -9999, 0, 1000, 800, 40)).toEqual({ x: 100, y: 100, w: 40, h: 300 });
    expect(resizeRect(r, 'w', 9999, 0, 1000, 800, 40)).toEqual({ x: 460, y: 100, w: 40, h: 300 });
    expect(resizeRect(r, 'se', 9999, 9999, 1000, 800, 40)).toEqual({ x: 100, y: 100, w: 900, h: 700 });
    expect(resizeRect(r, 'nw', -9999, -9999, 1000, 800, 40)).toEqual({ x: 0, y: 0, w: 500, h: 400 });
    for (const h of HANDLES) {
      const out = resizeRect(r, h, 7777, -7777, 1000, 800, 40);
      expect(out.w).toBeGreaterThanOrEqual(40);
      expect(out.h).toBeGreaterThanOrEqual(40);
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.y).toBeGreaterThanOrEqual(0);
      expect(out.x + out.w).toBeLessThanOrEqual(1000);
      expect(out.y + out.h).toBeLessThanOrEqual(800);
    }
  });

  it('the stored photo is the frame, shrunk to 1600px on its long side and never enlarged', () => {
    expect(outputSize({ x: 0, y: 0, w: 3200, h: 2000 })).toEqual({ w: 1600, h: 1000 });
    expect(outputSize({ x: 0, y: 0, w: 800, h: 500 })).toEqual({ w: 800, h: 500 });
    expect(outputSize({ x: 0, y: 0, w: 1, h: 4000 })).toEqual({ w: 1, h: 1600 });
  });
});

describe('the view (zoom and pan)', () => {
  const stage = { w: 400, h: 300 };
  const img = { w: 2000, h: 1000 };

  it('at rest the whole picture is shown, centred', () => {
    const v = resolveView(NO_ADJUST, stage, img);
    expect(v.scale).toBeCloseTo(fitScale(stage, img)); // 0.2: width-bound
    expect(v.scale).toBeCloseTo(0.2);
    expect(v.tx).toBeCloseTo(0);
    expect(v.ty).toBeCloseTo((300 - 200) / 2);
  });

  it('zoom is limited to 1…MAX_ZOOM times the fit', () => {
    expect(resolveView({ z: 0.1, ox: 0, oy: 0 }, stage, img).scale).toBeCloseTo(0.2);
    expect(resolveView({ z: 99, ox: 0, oy: 0 }, stage, img).scale).toBeCloseTo(0.2 * MAX_ZOOM);
  });

  it('cannot be panned while the whole picture fits, nor beyond its edges when zoomed', () => {
    const rest = resolveView({ z: 1, ox: 500, oy: -500 }, stage, img);
    expect(rest.tx).toBeCloseTo(0);
    expect(rest.ty).toBeCloseTo(50);
    const zoomed = resolveView({ z: 4, ox: 99999, oy: 99999 }, stage, img); // scale 0.8 → 1600×800
    expect(zoomed.tx).toBeCloseTo(0); // the left edge meets the stage's left edge
    expect(zoomed.ty).toBeCloseTo(0);
    const other = resolveView({ z: 4, ox: -99999, oy: -99999 }, stage, img);
    expect(other.tx).toBeCloseTo(400 - 1600);
    expect(other.ty).toBeCloseTo(300 - 800);
  });

  it('zooming keeps the picture point under the finger where it was', () => {
    const before = resolveView(NO_ADJUST, stage, img);
    const px = 300;
    const py = 120;
    const ix = (px - before.tx) / before.scale;
    const iy = (py - before.ty) / before.scale;
    const adj = zoomAt(NO_ADJUST, 3, px, py, stage, img);
    const after = resolveView(adj, stage, img);
    expect(after.scale).toBeCloseTo(before.scale * 3);
    expect(after.tx + ix * after.scale).toBeCloseTo(px);
    expect(after.ty + iy * after.scale).toBeCloseTo(py);
    // and back out
    const back = resolveView(zoomAt(adj, 1 / 3, px, py, stage, img), stage, img);
    expect(back.scale).toBeCloseTo(before.scale);
  });

  it('adjustFor is the inverse of resolveView', () => {
    const v = resolveView({ z: 3, ox: 40, oy: -25 }, stage, img);
    const again = resolveView(adjustFor(v.scale, v.tx, v.ty, stage, img), stage, img);
    expect(again.scale).toBeCloseTo(v.scale);
    expect(again.tx).toBeCloseTo(v.tx);
    expect(again.ty).toBeCloseTo(v.ty);
  });

  it('puts the frame on the stage', () => {
    const v = { scale: 0.5, tx: 10, ty: 20 };
    expect(rectOnStage({ x: 100, y: 200, w: 300, h: 400 }, v)).toEqual({ x: 60, y: 120, w: 150, h: 200 });
  });
});

// ── Finding the document ─────────────────────────────────────────────────────

interface Card { x: number; y: number; w: number; h: number; fill: string; rotate?: number }

/** A photographed-looking scene: a desk, a card on it with print and a dark photo patch. */
async function scene(opts: {
  w: number; h: number; bg: string; card: Card | null; noise?: number; jpeg?: boolean;
}): Promise<{ rgba: Buffer; w: number; h: number }> {
  const { w, h } = opts;
  const base = opts.noise
    ? sharp({ create: { width: w, height: h, channels: 3, background: opts.bg, noise: { type: 'gaussian', mean: 60, sigma: opts.noise } } })
    : sharp({ create: { width: w, height: h, channels: 3, background: opts.bg } });
  const layers: OverlayOptions[] = [];
  if (opts.card) {
    const c = opts.card;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(${c.rotate ?? 0} ${cx} ${cy})">
        <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${c.fill}"/>
        <rect x="${c.x + c.w * 0.06}" y="${c.y + c.h * 0.2}" width="${c.w * 0.25}" height="${c.h * 0.55}" fill="#3a3a3a"/>
        <rect x="${c.x + c.w * 0.4}" y="${c.y + c.h * 0.22}" width="${c.w * 0.5}" height="${c.h * 0.06}" fill="#222"/>
        <rect x="${c.x + c.w * 0.4}" y="${c.y + c.h * 0.4}" width="${c.w * 0.4}" height="${c.h * 0.06}" fill="#222"/>
        <rect x="${c.x + c.w * 0.4}" y="${c.y + c.h * 0.58}" width="${c.w * 0.45}" height="${c.h * 0.06}" fill="#222"/>
      </g></svg>`;
    layers.push({ input: Buffer.from(svg) });
  }
  let buf = await base.composite(layers).png().toBuffer();
  if (opts.jpeg) buf = await sharp(buf).jpeg({ quality: 60 }).toBuffer();
  const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, w, h };
}

function iou(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

describe('detectDocumentRect', () => {
  const truth: Rect = { x: 48, y: 36, w: 220, h: 140 };
  const card = (over: Partial<Card> = {}): Card => ({ ...truth, fill: '#e9e6dc', ...over });

  it('finds a light card on a dark desk', async () => {
    const s = await scene({ w: 320, h: 240, bg: '#26282b', card: card() });
    const r = detectDocumentRect(s.rgba, s.w, s.h);
    expect(r).not.toBeNull();
    expect(iou(r!, truth)).toBeGreaterThan(0.92); // the frame hugs the card, with a 1% margin
  });

  it('finds a dark card on a light desk', async () => {
    const s = await scene({ w: 320, h: 240, bg: '#e6dfcc', card: card({ fill: '#35496d' }) });
    const r = detectDocumentRect(s.rgba, s.w, s.h);
    expect(r).not.toBeNull();
    expect(iou(r!, truth)).toBeGreaterThan(0.9);
  });

  it('finds it at the size the app really uses (160px) after JPEG compression and sensor noise', async () => {
    const s = await scene({ w: 160, h: 120, bg: '#30302e', card: { x: 24, y: 18, w: 110, h: 70, fill: '#dcdad0' }, noise: 14, jpeg: true });
    const r = detectDocumentRect(s.rgba, s.w, s.h);
    expect(r).not.toBeNull();
    expect(iou(r!, { x: 24, y: 18, w: 110, h: 70 })).toBeGreaterThan(0.85);
  });

  it('a tilted card gives its bounding box', async () => {
    const tilt = 12;
    const s = await scene({ w: 320, h: 240, bg: '#26282b', card: card({ rotate: tilt }) });
    const cx = truth.x + truth.w / 2;
    const cy = truth.y + truth.h / 2;
    const a = (tilt * Math.PI) / 180;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [
      cx + sx! * (truth.w / 2) * Math.cos(a) - sy! * (truth.h / 2) * Math.sin(a),
      cy + sx! * (truth.w / 2) * Math.sin(a) + sy! * (truth.h / 2) * Math.cos(a),
    ] as const);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const box: Rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const r = detectDocumentRect(s.rgba, s.w, s.h);
    expect(r).not.toBeNull();
    expect(iou(r!, box)).toBeGreaterThan(0.85);
  });

  it('says "not sure" (null) for a picture with no document in it', async () => {
    const empty = await scene({ w: 320, h: 240, bg: '#4a6fa5', card: null });
    expect(detectDocumentRect(empty.rgba, empty.w, empty.h)).toBeNull();
    const noisy = await scene({ w: 320, h: 240, bg: '#4a6fa5', card: null, noise: 25 });
    expect(detectDocumentRect(noisy.rgba, noisy.w, noisy.h)).toBeNull();
  });

  it('says null for a white card on a white desk', async () => {
    const s = await scene({ w: 320, h: 240, bg: '#f2f2ee', card: card({ fill: '#f7f7f3' }) });
    expect(detectDocumentRect(s.rgba, s.w, s.h)).toBeNull();
  });

  it('says null when the card fills the frame, or is a speck', async () => {
    const full = await scene({ w: 320, h: 240, bg: '#26282b', card: { x: 4, y: 4, w: 312, h: 232, fill: '#e9e6dc' } });
    expect(detectDocumentRect(full.rgba, full.w, full.h)).toBeNull();
    const speck = await scene({ w: 320, h: 240, bg: '#26282b', card: { x: 140, y: 100, w: 50, h: 32, fill: '#e9e6dc' } });
    expect(detectDocumentRect(speck.rgba, speck.w, speck.h)).toBeNull();
  });

  it('says null for input it cannot read', () => {
    expect(detectDocumentRect(new Uint8Array(10), 4, 4)).toBeNull();
    expect(detectDocumentRect(new Uint8Array(8 * 8 * 4), 8, 8)).toBeNull();
    expect(detectDocumentRect(new Uint8Array(100), 100, 100)).toBeNull(); // buffer shorter than w*h*4
  });
});
