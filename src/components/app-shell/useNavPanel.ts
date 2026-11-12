'use client';

import { useState, useSyncExternalStore } from 'react';
import { categoryKind, findActive, type NavCategory } from './nav';

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
 *  (`collapsible`) and the mobile drawer (never collapsible).
 *
 *  Two kinds of category (`categoryKind`, decided after the permission filter):
 *   · a LINK category (one permitted item) is a direct link — it has no panel, and a click on
 *     it navigates (`openLink` hides the panel; the saved choice is not touched);
 *   · a PANEL category (two or more) never navigates: a click switches what the panel shows.
 *
 *  Terms: the route category = the one holding the current page's item; the shown category =
 *  the panel category the panel lists; the saved choice = `almog:sidebar-collapsed`.
 *   · on load and on every route change: a page of a panel category → it is the shown one and
 *     the panel is on (open unless the saved choice says closed); a page of a link category →
 *     the panel is off; a page in no category → nothing changes (a first load: panel off);
 *   · desktop, a click on a panel category: panel not shown → opens on it; showing another →
 *     switches; showing it → closes. The saved choice is written ONLY by this and by the
 *     collapse button — closing saves "closed", opening saves "open" (never by navigation);
 *   · mobile: the panel is on only once a panel category is picked or the page belongs to one.
 *
 *  The server and the hydration render see "open", the client then reads localStorage — no
 *  hydration mismatch. */
export function useNavPanel(categories: NavCategory[], pathname: string, collapsible: boolean) {
  const active = findActive(categories, pathname);
  const routeCategoryId = active?.categoryId ?? null;
  const routeCategory = categories.find((c) => c.id === routeCategoryId) ?? null;
  const routeIsPanel = !!routeCategory && categoryKind(routeCategory) === 'panel';

  const [shownId, setShownId] = useState<string | null>(routeIsPanel ? routeCategoryId : null);
  // The panel is "on" when the page (or a click) asked for it; the saved choice can still keep it closed.
  const [panelOn, setPanelOn] = useState(routeIsPanel);
  const [seenPath, setSeenPath] = useState(pathname);
  // The width transition is switched on by the first click or route change, so restoring a
  // saved "closed" state after mount snaps instead of animating.
  const [animate, setAnimate] = useState(false);
  if (pathname !== seenPath) {
    // Route changed: follow the new page's category (derived during render, not in an effect).
    setSeenPath(pathname);
    setAnimate(true);
    if (routeCategory) {
      if (routeIsPanel) setShownId(routeCategory.id);
      setPanelOn(routeIsPanel);
    }
  }

  const savedClosed = useSyncExternalStore(subscribe, readClosed, () => false);
  const closed = collapsible && savedClosed;

  // The panel holds the shown category even while it is off (so it can animate open and shut);
  // before any was shown it holds the first panel category, invisible. No panel category → no panel.
  const panelCategories = categories.filter((c) => categoryKind(c) === 'panel');
  const shown = panelCategories.find((c) => c.id === shownId) ?? panelCategories[0] ?? null;
  const open = shown !== null && panelOn && !closed;

  function setPanelClosed(next: boolean) {
    setAnimate(true);
    writeClosed(next);
  }

  /** A click on a PANEL category's rail button. */
  function selectCategory(id: string) {
    if (!collapsible) {
      setShownId(id);
      setPanelOn(true);
    } else if (open && shown?.id === id) {
      setPanelClosed(true);
    } else {
      setShownId(id);
      setPanelOn(true);
      if (!open) setPanelClosed(false);
    }
  }

  /** A click on a LINK category: the link navigates, the panel steps aside. Navigation alone
   *  would not do it when the page is already that one. The saved choice stays as it was. */
  function openLink() {
    setAnimate(true);
    setPanelOn(false);
  }

  return {
    shown,
    open,
    animate,
    activeHref: active?.href ?? null,
    /** The category that holds the current page's item (null: the page is in none). */
    routeCategoryId,
    /** What the rail marks: the shown category while the panel is open, otherwise the page's
     *  own category (link or panel) if it has one. */
    highlightedId: open && shown ? shown.id : routeCategoryId,
    selectCategory,
    openLink,
    closePanel: () => setPanelClosed(true),
  };
}
