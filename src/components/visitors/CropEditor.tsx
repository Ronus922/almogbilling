'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Loader2, Minus, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  adjustFor, defaultCropRect, fitScale, fullRect, HANDLES, MAX_ZOOM, minCropSide, moveRect, NO_ADJUST,
  rectOnStage, resizeRect, resolveView, zoomAt, type Handle, type Rect, type Size, type View, type ViewAdjust,
} from '@/lib/visitors/crop';
import { detectOnImage, renderCrop } from './cropCanvas';

// The crop step (09/11/2026): the photo of a document, a frame the user fits around it,
// and a JPEG of just that frame. Used twice — between the camera and the OCR (the
// guard), and on a stored photo ("חתוך מחדש", an admin) — so it is one component.
//
// Touch first (an iPhone at the gate): drag a corner or a side to resize, drag inside
// the frame to move it, pinch to zoom the picture, drag outside the frame to pan a
// zoomed picture. A mouse works the same; the wheel zooms and the buttons zoom too.
// The frame starts on the document when the finder (lib/visitors/cropDetect) is sure,
// else it is 85% of the picture, centred — and the user can always fix it.
//
// All gestures are Pointer Events on one element with `touch-action: none`, so the
// browser never scrolls or page-zooms under a finger. The frame lives in the PICTURE's
// pixels and the zoom/pan in a small adjustment (lib/visitors/crop), so nothing here
// has to repair state when the box is resized.

interface Props {
  /** Anything an <img> can show: an object URL of the photo, or the stored photo's path. */
  src: string;
  /** 'auto' = look for the document, else 85% centred. 'full' = the whole picture (a re-crop). */
  initial: 'auto' | 'full';
  confirmLabel: string;
  cancelLabel: string;
  /** The parent is working on the answer (disables the buttons). */
  busy?: boolean;
  onConfirm: (jpeg: Blob) => void;
  onCancel: () => void;
  /** The picture could not be opened (a format this browser cannot draw). */
  onLoadError: () => void;
}

const GUTTER = 16; // room around the picture for handles that sit on its very edge
const KEY_ZOOM_STEP = 1.4;

type Gesture =
  | { kind: 'idle' }
  | { kind: 'rect'; id: number; handle: Handle | 'move'; x0: number; y0: number; rect0: Rect; scale: number }
  | { kind: 'pan'; id: number; x0: number; y0: number; view0: View }
  | { kind: 'pinch'; ids: [number, number]; dist0: number; mid0: { x: number; y: number }; view0: View };

const HANDLE_POS: Record<Handle, CSSProperties> = {
  nw: { left: 0, top: 0 }, n: { left: '50%', top: 0 }, ne: { left: '100%', top: 0 },
  e: { left: '100%', top: '50%' }, se: { left: '100%', top: '100%' }, s: { left: '50%', top: '100%' },
  sw: { left: 0, top: '100%' }, w: { left: 0, top: '50%' },
};
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'cursor-nwse-resize', se: 'cursor-nwse-resize', ne: 'cursor-nesw-resize', sw: 'cursor-nesw-resize',
  n: 'cursor-ns-resize', s: 'cursor-ns-resize', e: 'cursor-ew-resize', w: 'cursor-ew-resize',
};

function Dot({ handle }: { handle: Handle }) {
  const corner = handle.length === 2;
  const horizontal = handle === 'n' || handle === 's';
  return (
    <span
      aria-hidden
      className={cn(
        'block border-2 border-white bg-brand shadow-md',
        corner ? 'h-5 w-5 rounded-full' : horizontal ? 'h-2.5 w-8 rounded-full' : 'h-8 w-2.5 rounded-full',
      )}
    />
  );
}

export function CropEditor({ src, initial, confirmLabel, cancelLabel, busy = false, onConfirm, onCancel, onLoadError }: Props) {
  const [loaded, setLoaded] = useState<{ img: HTMLImageElement; start: Rect; auto: boolean } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [adj, setAdj] = useState<ViewAdjust>(NO_ADJUST);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const [working, setWorking] = useState(false);

  const outerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>({ kind: 'idle' });
  const loadErrorRef = useRef(onLoadError);
  useEffect(() => { loadErrorRef.current = onLoadError; });

  // Open the picture, and decide where the frame starts.
  useEffect(() => {
    let cancelled = false;
    const im = new Image();
    im.onload = () => {
      if (cancelled) return;
      const w = im.naturalWidth;
      const h = im.naturalHeight;
      if (w === 0 || h === 0) { loadErrorRef.current(); return; }
      const found = initial === 'auto' ? detectOnImage(im) : null;
      const start = initial === 'full' ? fullRect(w, h) : found ?? defaultCropRect(w, h);
      setLoaded({ img: im, start, auto: found !== null });
      setRect(start);
    };
    im.onerror = () => { if (!cancelled) loadErrorRef.current(); };
    im.src = src;
    return () => { cancelled = true; im.onload = null; im.onerror = null; };
  }, [src, initial]);

  // The box the picture is fitted in (its size changes with the sheet / the phone's turn).
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const imgSize: Size = loaded ? { w: loaded.img.naturalWidth, h: loaded.img.naturalHeight } : { w: 0, h: 0 };
  const ready = loaded !== null && rect !== null && stage.w > 0 && stage.h > 0;
  const view = ready ? resolveView(adj, stage, imgSize) : null;
  const min = loaded ? minCropSide(imgSize.w, imgSize.h) : 0;

  // Wheel zoom (a non-passive native listener: React's onWheel cannot preventDefault).
  useEffect(() => {
    const el = outerRef.current;
    const layer = layerRef.current;
    if (!el || !layer || !loaded || stage.w <= 0) return;
    const size = { w: loaded.img.naturalWidth, h: loaded.img.naturalHeight };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = layer.getBoundingClientRect();
      setAdj((a) => zoomAt(a, Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top, stage, size));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [loaded, stage]);

  function local(e: React.PointerEvent): { x: number; y: number } {
    const box = layerRef.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  function startPan(id: number, view0: View) {
    const p = pointers.current.get(id);
    gesture.current = p ? { kind: 'pan', id, x0: p.x, y0: p.y, view0 } : { kind: 'idle' };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!view || !rect) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    try { outerRef.current?.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.entries()];
      const pa = a![1];
      const pb = b![1];
      gesture.current = {
        kind: 'pinch', ids: [a![0], b![0]], dist0: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)),
        mid0: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, view0: view,
      };
      return;
    }
    const target = (e.target as Element).closest<HTMLElement>('[data-crop-handle]');
    const handle = target?.dataset.cropHandle as Handle | 'move' | undefined;
    if (handle) {
      gesture.current = { kind: 'rect', id: e.pointerId, handle, x0: p.x, y0: p.y, rect0: rect, scale: view.scale };
    } else {
      startPan(e.pointerId, view);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId) || !loaded) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;

    if (g.kind === 'rect' && g.id === e.pointerId) {
      const dx = (p.x - g.x0) / g.scale;
      const dy = (p.y - g.y0) / g.scale;
      setRect(g.handle === 'move'
        ? moveRect(g.rect0, dx, dy, imgSize.w, imgSize.h)
        : resizeRect(g.rect0, g.handle, dx, dy, imgSize.w, imgSize.h, min));
    } else if (g.kind === 'pan' && g.id === e.pointerId) {
      setAdj(adjustFor(g.view0.scale, g.view0.tx + (p.x - g.x0), g.view0.ty + (p.y - g.y0), stage, imgSize));
    } else if (g.kind === 'pinch') {
      const pa = pointers.current.get(g.ids[0]);
      const pb = pointers.current.get(g.ids[1]);
      if (!pa || !pb) return;
      const fit = fitScale(stage, imgSize);
      const scale = Math.min(Math.max(g.view0.scale * (Math.hypot(pa.x - pb.x, pa.y - pb.y) / g.dist0), fit), fit * MAX_ZOOM);
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      // The picture point that was under the fingers' midpoint stays under it.
      const ix = (g.mid0.x - g.view0.tx) / g.view0.scale;
      const iy = (g.mid0.y - g.view0.ty) / g.view0.scale;
      setAdj(adjustFor(scale, mid.x - ix * scale, mid.y - iy * scale, stage, imgSize));
    }
  }

  function onPointerEnd(e: React.PointerEvent) {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g.kind === 'pinch') {
      // One finger stays down: carry on as a pan from where the picture is now.
      const [rest] = [...pointers.current.keys()];
      if (rest !== undefined && view) startPan(rest, resolveView(adj, stage, imgSize));
      else gesture.current = { kind: 'idle' };
    } else if ((g.kind === 'rect' || g.kind === 'pan') && g.id === e.pointerId) {
      gesture.current = { kind: 'idle' };
    }
  }

  function zoomBy(factor: number) {
    if (!loaded) return;
    setAdj((a) => zoomAt(a, factor, stage.w / 2, stage.h / 2, stage, imgSize));
  }

  async function confirm() {
    if (!loaded || !rect || working || busy) return;
    setWorking(true);
    try {
      onConfirm(await renderCrop(loaded.img, rect));
    } catch {
      toast.error('לא ניתן לחתוך את התמונה — נסה שוב');
    } finally {
      setWorking(false);
    }
  }

  const box = view && rect ? rectOnStage(rect, view) : null;
  const disabled = busy || working;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50/60" data-crop-editor>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        <div
          ref={outerRef} data-crop-stage data-crop-zoom={adj.z.toFixed(2)}
          role="application" aria-label="אזור חיתוך התעודה"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          style={{ WebkitTouchCallout: 'none' }}
          className="relative min-h-60 flex-1 touch-none select-none overflow-hidden rounded-lg border border-slate-200 bg-slate-900"
        >
          <div ref={layerRef} dir="ltr" className="absolute" style={{ inset: GUTTER }}>
            {!ready && (
              <div role="status" aria-live="polite" className="absolute inset-0 flex items-center justify-center text-white/80">
                <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
              </div>
            )}
            {ready && view && box && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- the photo just taken (an object URL) or a private, session-gated proxy path; next/image cannot take either */}
                <img
                  src={src} alt="" draggable={false} onDragStart={(e) => e.preventDefault()}
                  className="pointer-events-none absolute max-w-none select-none"
                  style={{ left: view.tx, top: view.ty, width: imgSize.w * view.scale, height: imgSize.h * view.scale }}
                />
                <div
                  data-crop-rect data-crop-handle="move"
                  data-x={Math.round(rect!.x)} data-y={Math.round(rect!.y)} data-w={Math.round(rect!.w)} data-h={Math.round(rect!.h)}
                  className="absolute cursor-move border-2 border-white"
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h, boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.58)' }}
                >
                  {HANDLES.map((h) => (
                    <span
                      key={h} data-crop-handle={h}
                      className={cn('absolute flex h-11 w-11 items-center justify-center', HANDLE_CURSOR[h])}
                      style={{ ...HANDLE_POS[h], transform: 'translate(-50%, -50%)' }}
                    >
                      <Dot handle={h} />
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-none items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-slate-600" data-crop-hint>
            {loaded?.auto
              ? 'זיהינו את התעודה. תקן את המסגרת במידת הצורך — גרור פינות וצדדים, הזז מבפנים, והתקרב בצביטה.'
              : 'גרור את הפינות והצדדים עד שהמסגרת מקיפה את התעודה בלבד. אפשר להזיז מבפנים ולהתקרב בצביטה.'}
          </p>
          <div className="flex flex-none items-center gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="הקטן" onClick={() => zoomBy(1 / KEY_ZOOM_STEP)} disabled={!ready} data-crop-zoom-out className="h-11 w-11">
              <Minus className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="icon" aria-label="הגדל" onClick={() => zoomBy(KEY_ZOOM_STEP)} disabled={!ready} data-crop-zoom-in className="h-11 w-11">
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              type="button" variant="outline" size="icon" aria-label="אפס מסגרת" data-crop-reset className="h-11 w-11"
              onClick={() => { if (loaded) { setRect(loaded.start); setAdj(NO_ADJUST); } }} disabled={!ready}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      </div>

      <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled} data-crop-cancel>
            {cancelLabel}
          </Button>
          <Button type="button" onClick={() => void confirm()} disabled={!ready || disabled} data-crop-confirm className="gap-2">
            {disabled && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </Button>
        </div>
      </footer>
    </div>
  );
}
