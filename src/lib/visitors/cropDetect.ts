import type { Rect } from './crop';

// Finds the document in a photo so the crop frame can start on it (09/11/2026).
//
// No OpenCV, no dependency: the picture is shrunk to ~160px by the caller and this
// reads its pixels. The idea is the one a person uses — a document is the big
// patch that does NOT look like the surface it lies on.
//
//   1. the background colour = the median of a thin ring around the picture;
//   2. every pixel's distance from it → Otsu threshold → "document-ish" mask;
//   3. the mask is dilated (so print and a photo on the card do not tear it apart)
//      and the LARGEST connected blob is taken;
//   4. its bounding box is accepted only when it is plausible: a sensible share of
//      the picture, mostly filled, not a thin sliver.
//
// It returns null whenever it is not sure — a white card on a white desk, a card
// that fills the frame, clutter — and the caller falls back to a centred 85%
// frame. Better no guess than a wrong one the guard has to undo.

const RING_FRACTION = 0.05;
/** Below this the "document" is too close to the background colour to tell apart (L1 over r+g+b). */
const MIN_THRESHOLD = 45;
/** The blob's own average distance from the background: less is a shadow, not a card. */
const MIN_BLOB_CONTRAST = 100;
const DILATE_RADIUS = 2;
const MIN_AREA_SHARE = 0.15;
const MAX_AREA_SHARE = 0.96;
const MIN_FILL = 0.55;
const MIN_ASPECT = 0.45;
const MAX_ASPECT = 2.6;
const PAD_FRACTION = 0.01;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Otsu's threshold over a 256-bin histogram: the cut that best separates two groups. */
function otsu(hist: Uint32Array, total: number): number {
  let sumAll = 0;
  for (let i = 0; i < 256; i += 1) sumAll += i * (hist[i] ?? 0);
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t] ?? 0;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] ?? 0);
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/** Square dilation by `r`, as two separable passes. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !on; k += 1) on = mask[y * w + k] ?? 0;
      tmp[y * w + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !on; k += 1) on = tmp[k * w + x] ?? 0;
      out[y * w + x] = on;
    }
  }
  return out;
}

interface Blob {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Pixels of the blob, row by row from minY: the first and the last column it covers. */
  spans: Map<number, [number, number]>;
}

/** The largest 4-connected blob of set pixels. */
function largestBlob(mask: Uint8Array, w: number, h: number): Blob | null {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: Blob | null = null;
  for (let start = 0; start < w * h; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const blob: Blob = { area: 0, minX: w, minY: h, maxX: 0, maxY: 0, spans: new Map() };
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % w;
      const y = (p - x) / w;
      blob.area += 1;
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      const span = blob.spans.get(y);
      if (span) {
        if (x < span[0]) span[0] = x;
        if (x > span[1]) span[1] = x;
      } else {
        blob.spans.set(y, [x, x]);
      }
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (!best || blob.area > best.area) best = blob;
  }
  return best;
}

/**
 * @param rgba   RGBA bytes of the (already shrunk) picture, row by row.
 * @param w,h    its size in pixels.
 * @returns the document's bounding box in the SAME pixel space, or null when unsure.
 */
export function detectDocumentRect(rgba: ArrayLike<number>, w: number, h: number): Rect | null {
  if (w < 16 || h < 16 || rgba.length < w * h * 4) return null;

  // 1 — the background colour, from the ring around the picture.
  const t = Math.max(2, Math.round(Math.min(w, h) * RING_FRACTION));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x >= t && x < w - t && y >= t && y < h - t) continue;
      const i = (y * w + x) * 4;
      rs.push(rgba[i]!);
      gs.push(rgba[i + 1]!);
      bs.push(rgba[i + 2]!);
    }
  }
  const br = median(rs);
  const bg = median(gs);
  const bb = median(bs);

  // 2 — distance from it (L1 over r+g+b, 0…765) → histogram → Otsu.
  const dist = new Uint16Array(w * h);
  const hist = new Uint32Array(256);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    const d = Math.abs(rgba[i]! - br) + Math.abs(rgba[i + 1]! - bg) + Math.abs(rgba[i + 2]! - bb);
    dist[p] = d;
    hist[Math.min(255, Math.floor(d / 3))] += 1;
  }
  const threshold = Math.max(otsu(hist, w * h) * 3, MIN_THRESHOLD);

  // 3 — mask, close the gaps print leaves, take the largest blob.
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p += 1) mask[p] = dist[p]! > threshold ? 1 : 0;
  const blob = largestBlob(dilate(mask, w, h, DILATE_RADIUS), w, h);
  if (!blob) return null;

  // The dilation grew the blob by the radius on every side that was not the picture's edge.
  const shrink = (edge: number, atEdge: boolean, sign: 1 | -1) => (atEdge ? edge : edge + sign * DILATE_RADIUS);
  const x0 = shrink(blob.minX, blob.minX === 0, 1);
  const y0 = shrink(blob.minY, blob.minY === 0, 1);
  const x1 = shrink(blob.maxX, blob.maxX === w - 1, -1) + 1;
  const y1 = shrink(blob.maxY, blob.maxY === h - 1, -1) + 1;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return null;

  // 4 — is it a plausible document?
  const share = (bw * bh) / (w * h);
  if (share < MIN_AREA_SHARE || share > MAX_AREA_SHARE) return null;
  const aspect = bw / bh;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return null;
  // Fill: how much of its box the blob covers, counting the holes inside a row as covered
  // (a dark photo or a stamp on the card is not a gap in the card).
  let covered = 0;
  for (const [, [a, b]] of blob.spans) covered += b - a + 1;
  if (covered / (blob.maxX - blob.minX + 1) / (blob.maxY - blob.minY + 1) < MIN_FILL) return null;
  // Contrast: the blob's own pixels (the undilated ones inside its box) must really differ from the desk.
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (mask[y * w + x]) { sum += dist[y * w + x]!; n += 1; }
    }
  }
  if (n === 0 || sum / n < MIN_BLOB_CONTRAST) return null;

  const pad = Math.round(Math.min(w, h) * PAD_FRACTION);
  const left = Math.max(0, x0 - pad);
  const top = Math.max(0, y0 - pad);
  return { x: left, y: top, w: Math.min(w, x1 + pad) - left, h: Math.min(h, y1 + pad) - top };
}
