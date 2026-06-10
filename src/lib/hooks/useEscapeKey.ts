'use client';

import { useEffect, useRef } from 'react';

/**
 * Defensive ESC-key listener that closes overlays at the document level.
 *
 * Background: Base UI's built-in ESC handling is supposed to fire on
 * `Dialog.Root` / `Sheet.Root` / `AlertDialog.Root`, but in this project
 * it stopped working for all overlays. Rather than chase the Base UI
 * regression, we attach a redundant document-level keydown listener
 * here. If Base UI's listener also fires, the second `onEscape()` call
 * is a no-op (the overlay is already closing).
 *
 * Stack-aware: only the most-recently-mounted active listener fires.
 * This makes nested overlays (e.g. a confirm AlertDialog inside a
 * Sheet) close in LIFO order — the topmost one first.
 *
 * Usage:
 *   useEscapeKey(open && !confirmOpen, requestClose);
 *   useEscapeKey(confirmOpen, () => setConfirmOpen(false));
 */

interface StackEntry {
  cb: () => void;
}

const stack: StackEntry[] = [];

let listenerAttached = false;

function ensureListener() {
  if (listenerAttached) return;
  listenerAttached = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = stack[stack.length - 1];
    if (!top) return;
    e.preventDefault();
    top.cb();
  });
}

export function useEscapeKey(active: boolean, onEscape: () => void) {
  // Stable ref so the consumer's callback identity doesn't churn the effect.
  const cbRef = useRef(onEscape);
  cbRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    if (typeof document === 'undefined') return;

    ensureListener();
    const entry: StackEntry = { cb: () => cbRef.current() };
    stack.push(entry);

    return () => {
      const idx = stack.lastIndexOf(entry);
      if (idx >= 0) stack.splice(idx, 1);
    };
  }, [active]);
}
