// The geometry of the document crop (09/11/2026) — pure numbers, no DOM, no React:
// the editor component and the unit tests read the same code.
//
// Two coordinate spaces:
//   • IMAGE space — pixels of the picture itself. The crop `Rect` lives here, so it
//     does not move when the view is zoomed or the phone is turned.
//   • STAGE space — CSS pixels of the box the picture is shown in. A `View` maps
//     one to the other: stage = image × scale + (tx, ty).
//
// The view is stored as an ADJUSTMENT of the "fit" view (the whole picture,
// centred): `z` times larger and moved by (ox, oy). The actual view is always
// derived from it (resolveView), so a resized stage can never leave the picture
// off-screen and no effect has to repair state.

import { CLIENT_UPLOAD_MAX_SIDE } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Corners last, so on a tiny frame a corner wins over the side handle under it. */
export const HANDLES: readonly Handle[] = ['n', 'e', 's', 'w', 'nw', 'ne', 'se', 'sw'];

/** When no document is found, the frame is this much of the picture, centred. */
export const DEFAULT_CROP_FRACTION = 0.85;


export function fullRect(imgW: number, imgH: number): Rect {
  return { x: 0, y: 0, w: imgW, h: imgH };
}

export function defaultCropRect(imgW: number, imgH: number, fraction = DEFAULT_CROP_FRACTION): Rect {
  const w = Math.round(imgW * fraction);
  const h = Math.round(imgH * fraction);
  return { x: Math.round((imgW - w) / 2), y: Math.round((imgH - h) / 2), w, h };
}

/** The smallest frame a user can shrink to: big enough to hold a readable document. */
export function minCropSide(imgW: number, imgH: number): number {
  return Math.min(Math.max(32, Math.round(Math.min(imgW, imgH) * 0.05)), imgW, imgH);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Keeps a frame inside the picture and at least `min` on both sides. */
export function clampRect(r: Rect, imgW: number, imgH: number, min: number): Rect {
  const w = clamp(r.w, Math.min(min, imgW), imgW);
  const h = clamp(r.h, Math.min(min, imgH), imgH);
  return { x: clamp(r.x, 0, imgW - w), y: clamp(r.y, 0, imgH - h), w, h };
}

/** Drags the whole frame by (dx, dy) image pixels; its size never changes. */
export function moveRect(r: Rect, dx: number, dy: number, imgW: number, imgH: number): Rect {
  return { ...r, x: clamp(r.x + dx, 0, imgW - r.w), y: clamp(r.y + dy, 0, imgH - r.h) };
}

/** Drags one handle by (dx, dy) image pixels; the opposite edges stay where they are. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, imgW: number, imgH: number, min: number): Rect {
  let left = r.x;
  let right = r.x + r.w;
  let top = r.y;
  let bottom = r.y + r.h;
  const m = Math.min(min, imgW, imgH);
  if (handle.includes('w')) left = clamp(left + dx, 0, right - m);
  if (handle.includes('e')) right = clamp(right + dx, left + m, imgW);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - m);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + m, imgH);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The size the cropped photo is drawn at: the frame, shrunk (never enlarged) to `maxSide` — 2000px,
 *  so a 12MP photo does not cross a mobile connection at full size; the server brings it to 1600. */
export function outputSize(r: Rect, maxSide = CLIENT_UPLOAD_MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, maxSide / Math.max(r.w, r.h));
  return { w: Math.max(1, Math.round(r.w * k)), h: Math.max(1, Math.round(r.h * k)) };
}

// ── The view (zoom + pan of the picture inside its box) ──────────────────────

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewAdjust {
  /** Zoom over the fit view: 1 = the whole picture, up to MAX_ZOOM. */
  z: number;
  /** Extra offset from the centred position, stage pixels. */
  ox: number;
  oy: number;
}

export const MAX_ZOOM = 8;
export const NO_ADJUST: ViewAdjust = { z: 1, ox: 0, oy: 0 };

export interface Size {
  w: number;
  h: number;
}

/** Scale at which the whole picture fits the stage. */
export function fitScale(stage: Size, img: Size): number {
  if (stage.w <= 0 || stage.h <= 0 || img.w <= 0 || img.h <= 0) return 1;
  return Math.min(stage.w / img.w, stage.h / img.h);
}

/** The real view for an adjustment: zoom limited to 1…MAX_ZOOM, and the picture can
 *  be moved only until its edge meets the stage's edge (a picture smaller than the
 *  stage in one direction stays centred in it). */
export function resolveView(adj: ViewAdjust, stage: Size, img: Size): View {
  const fit = fitScale(stage, img);
  const z = clamp(adj.z, 1, MAX_ZOOM);
  const scale = fit * z;
  const dw = img.w * scale;
  const dh = img.h * scale;
  const maxOx = Math.max(0, (dw - stage.w) / 2);
  const maxOy = Math.max(0, (dh - stage.h) / 2);
  return {
    scale,
    tx: (stage.w - dw) / 2 + clamp(adj.ox, -maxOx, maxOx),
    ty: (stage.h - dh) / 2 + clamp(adj.oy, -maxOy, maxOy),
  };
}

/** The adjustment that produces a given scale and position (resolveView clamps it). */
export function adjustFor(scale: number, tx: number, ty: number, stage: Size, img: Size): ViewAdjust {
  const fit = fitScale(stage, img);
  return {
    z: scale / fit,
    ox: tx - (stage.w - img.w * scale) / 2,
    oy: ty - (stage.h - img.h * scale) / 2,
  };
}

/** Zooms by `factor` keeping the picture point under the stage point (px, py) in place. */
export function zoomAt(adj: ViewAdjust, factor: number, px: number, py: number, stage: Size, img: Size): ViewAdjust {
  const v = resolveView(adj, stage, img);
  const fit = fitScale(stage, img);
  const scale = clamp(v.scale * factor, fit, fit * MAX_ZOOM);
  const ix = (px - v.tx) / v.scale;
  const iy = (py - v.ty) / v.scale;
  return adjustFor(scale, px - ix * scale, py - iy * scale, stage, img);
}

/** Where a frame is on the stage. */
export function rectOnStage(r: Rect, v: View): Rect {
  return { x: v.tx + r.x * v.scale, y: v.ty + r.y * v.scale, w: r.w * v.scale, h: r.h * v.scale };
}
