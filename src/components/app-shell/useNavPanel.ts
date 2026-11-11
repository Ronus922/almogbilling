'use client';

import { useState, useSyncExternalStore } from 'react';
import { findActive, type NavCategory } from './nav';

// Existing key (it belonged to the old sidebar's collapse state): '1' = the panel is closed.
const STORAGE_KEY = 'almog:sidebar-collapsed';

// Blocked / full storage (private mode, cookies off): the choice still has to work inside the
// session, so it is also kept in memory — only surviving a reload needs localStorage.
let memoryClosed: boolean | null = null;

function readClosed(): boolean {
  if (memoryClosed !== null) return memoryClosed;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// The saved choice is an external store: the server (and the hydration render) see "open",
// the client then reads localStorage — so the markup always matches on hydration.
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function writeClosed(closed: boolean): void {
  memoryClosed = closed;
  try {
    localStorage.setItem(STORAGE_KEY, closed ? '1' : '0');
  } catch {
    // Not persisted — see memoryClosed above.
  }
  listeners.forEach((l) => l());
}

/** The behaviour of the rail + panel (DESIGN.md §14), shared by the desktop sidebar
 *  (`collapsible`) and the mobile drawer (never collapsible):
 *   · the panel SHOWS the category of the current page — on load and on every route change;
 *     a page in no category leaves the last one shown (first permitted one on first load);
 *   · a click on a rail button never navigates: it switches what the panel shows;
 *   · desktop only: the same button again closes the panel, any button opens a closed one,
 *     and the choice is remembered (the server and hydration render see "open", the client then
 *     reads localStorage — no hydration mismatch);
 *   · navigating never opens a closed panel. */
export function useNavPanel(categories: NavCategory[], pathname: string, collapsible: boolean) {
  const active = findActive(categories, pathname);
  const routeCategoryId = active?.categoryId ?? null;

  const [pickedId, setPickedId] = useState<string>(routeCategoryId ?? categories[0]?.id ?? '');
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    // Route changed: show the new page's category (derived during render, not in an effect).
    setSeenPath(pathname);
    if (routeCategoryId) setPickedId(routeCategoryId);
  }

  const savedClosed = useSyncExternalStore(subscribe, readClosed, () => false);
  const closed = collapsible && savedClosed;
  // The width transition is switched on by the first click, so restoring a saved "closed"
  // state after mount snaps instead of animating.
  const [animate, setAnimate] = useState(false);

  const shown = categories.find((c) => c.id === pickedId) ?? categories[0] ?? null;
  const open = !closed;

  function setPanelClosed(next: boolean) {
    setAnimate(true);
    writeClosed(next);
  }

  function selectCategory(id: string) {
    if (!collapsible) {
      setPickedId(id);
    } else if (closed) {
      setPickedId(id);
      setPanelClosed(false);
    } else if (shown?.id === id) {
      setPanelClosed(true);
    } else {
      setPickedId(id);
    }
  }

  return {
    shown,
    open,
    animate,
    activeHref: active?.href ?? null,
    /** What the rail highlights: the shown category while the panel is open, the page's own
     *  category (if it has one) while it is closed. */
    highlightedId: open ? (shown?.id ?? null) : routeCategoryId,
    selectCategory,
    closePanel: () => setPanelClosed(true),
  };
}
