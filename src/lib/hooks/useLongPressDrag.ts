'use client';

import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';

export interface DragPoint {
  x: number;
  y: number;
}

export interface LongPressDragHandlers {
  /** The finger stayed put for `delay` ms on item `id`: the drag starts here. */
  onStart: (id: string, point: DragPoint) => void;
  /** Every move while dragging (the page does not scroll meanwhile). */
  onMove: (point: DragPoint) => void;
  /** The finger left the screen while dragging, at `point`. */
  onDrop: (point: DragPoint) => void;
  /** The drag ended without a drop (touchcancel, or the browser took the gesture). */
  onCancel: () => void;
}

/**
 * Touch drag by long press, for boards whose mouse drag is native HTML5 drag
 * and drop (which a phone or tablet does not deliver). A touch that moves more
 * than `tolerance` px before `delay` ms is a scroll and is left to the browser;
 * a touch lifted before that is a tap, so the element's own click still fires.
 * Once the hold completes, `touchmove` is cancelled (non-passive listener) so
 * the page stays still while the item follows the finger, and the click that
 * would follow the lift is cancelled too.
 *
 * `holding` is true from touchstart to the end of the gesture: render the item
 * `draggable={false}` meanwhile, so a mobile browser's own long-press drag
 * does not race this one.
 */
export function useLongPressDrag(
  handlers: LongPressDragHandlers,
  { enabled, delay = 500, tolerance = 10 }: { enabled: boolean; delay?: number; tolerance?: number },
) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const [holding, setHolding] = useState(false);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    const gesture = stop;
    return () => gesture.current?.();
  }, []);

  function onTouchStart(id: string, e: ReactTouchEvent<HTMLElement>) {
    if (!enabled || e.touches.length !== 1 || stop.current) return;
    const first = e.touches[0];
    const start: DragPoint = { x: first.clientX, y: first.clientY };
    let last = start;
    let active = false;
    let timer = 0;

    const finish = () => {
      window.clearTimeout(timer);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', lift);
      document.removeEventListener('touchcancel', cancel);
      stop.current = null;
      setHolding(false);
    };
    const move = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      last = { x: t.clientX, y: t.clientY };
      if (!active) {
        if (Math.hypot(last.x - start.x, last.y - start.y) > tolerance) finish(); // a scroll
        return;
      }
      if (!ev.cancelable) { // the browser is already scrolling — give it the gesture
        finish();
        latest.current.onCancel();
        return;
      }
      ev.preventDefault();
      latest.current.onMove(last);
    };
    const lift = (ev: TouchEvent) => {
      const wasActive = active;
      if (wasActive && ev.cancelable) ev.preventDefault(); // no click after a drag
      finish();
      if (wasActive) latest.current.onDrop(last);
    };
    const cancel = () => {
      const wasActive = active;
      finish();
      if (wasActive) latest.current.onCancel();
    };
    timer = window.setTimeout(() => {
      active = true;
      if ('vibrate' in navigator) navigator.vibrate(12);
      latest.current.onStart(id, last);
    }, delay);

    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', lift, { passive: false });
    document.addEventListener('touchcancel', cancel);
    stop.current = finish;
    setHolding(true);
  }

  return { holding, onTouchStart };
}
