// Where a dragged card would land — the DOM arithmetic the issues kanban and
// the reminders list share (06/10/2026). Mouse and touch use the same rule:
// the card lands above the first card whose middle is below the pointer.

import type { DragPoint } from '@/lib/hooks/useLongPressDrag';

/** The element that scrolls `el` (the app shell's <main>, not window). */
export function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function inside(r: DOMRect, p: DragPoint): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** The card (an element carrying `idAttr`) a drop at height `y` lands above
 *  inside `container`: the first one, other than `skipId` (the card being
 *  dragged), whose middle is below `y`; none = the bottom. */
export function landingAboveIn(container: HTMLElement, y: number, skipId: string | null, idAttr: string): string | null {
  for (const el of container.querySelectorAll<HTMLElement>(`[${idAttr}]`)) {
    const id = el.getAttribute(idAttr);
    if (id === null || id === skipId) continue;
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) return id;
  }
  return null;
}
