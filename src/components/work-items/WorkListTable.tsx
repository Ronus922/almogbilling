'use client';

// תקלות/משימות — the list view (12/10/2026, pixel-exact adoption of
// ref/issues-board.html `.list`/`.lrow`/`.ldet`): a flat table, grid
// `1fr / 230px / 200px` (title | created | responsible), unassigned items
// pinned at the top with an inline "+ ללא שיוך" picker, row-expand on click
// (description + location/priority chips + image thumbnails, fetched lazily
// from the per-kind detail route), floating hover actions, and the
// multi-assignee avatar stack (addition beyond the reference, רונן's spec).
// Kanban is the default view; this is the alternate (`.vt` toggle) and the
// only board on < lg.

import { useRef, useState } from 'react';
import { AlertOctagon, ChevronDown, Camera, Check, Pencil, Trash2, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WORK_PRIORITY_CARD, WORK_PRIORITY_ROW_HOVER, WORK_PRIORITY_LABEL, avatarColorFor } from '@/lib/constants/workItems';
import { useLongPressDrag, type DragPoint } from '@/lib/hooks/useLongPressDrag';
import { inside, landingAboveIn, scrollParent } from '@/lib/dnd/landing';
import { AssigneeAvatarStack } from './AssigneeAvatarStack';
import { PrimaryAssigneePicker } from './PrimaryAssigneePicker';
import { ImageLightbox } from '@/components/issues/ImageLightbox';
import type { WorkItem, WorkItemKind } from '@/lib/types/workItems';

// A row's own attribute, distinct from the board card's `data-work-item-id`
// (src/components/work-items/WorkItemsBoard.tsx) — WorkEntityScreen renders
// the list ALONGSIDE the board (hidden under `lg`, not unmounted), so sharing
// one attribute string made every `[data-work-item-id="<id>"]` e2e locator
// resolve to two elements (board card + list row) and break strict mode.
const ID_ATTR = 'data-work-row-id';

interface Detail {
  description: string | null;
  location: string | null;
  images: string[];
}

/** 'YYYY-MM-DDTHH:mm:ss...' → 'DD.MM · HH:MM'. */
function fmtCreated(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')} · ${get('hour')}:${get('minute')}`;
}

async function fetchDetail(kind: WorkItemKind, id: string): Promise<Detail> {
  const res = await fetch(`/api/${kind === 'issue' ? 'issues' : 'tasks'}/${id}`, { credentials: 'include' });
  if (!res.ok) return { description: null, location: null, images: [] };
  const data = (await res.json()) as { issue?: { description?: string | null; location_text?: string | null; images?: string[] }; task?: { description?: string | null } };
  const row: { description?: string | null; location_text?: string | null; images?: string[] } = data.issue ?? data.task ?? {};
  return {
    description: row.description ?? null,
    location: row.location_text ?? null,
    images: Array.isArray(row.images) ? row.images : [],
  };
}

/** Where a drop would land: the row it would sit above (null = the bottom). */
interface Landing {
  beforeId: string | null;
}

/** A row carried by a finger: where it started, and what scrolls under it. */
interface Carried {
  id: string;
  el: HTMLElement;
  start: DragPoint;
  last: DragPoint;
  scroller: HTMLElement;
  scrollTop0: number;
  raf: number;
}

export function WorkListTable({
  kind,
  items,
  canEdit,
  employees,
  suppliers,
  onOpen,
  onAssign,
  onReorder,
  onMarkDone,
  onBlockedClick,
  onDelete,
}: {
  kind: WorkItemKind;
  items: WorkItem[];
  canEdit: boolean;
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  onOpen: (item: WorkItem) => void;
  onAssign: (item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  /** The dots handle (`.wb-handle-row`, DESIGN.md §41) drags a row to a new
   *  position (13/10/2026, decision 6) — mouse: native HTML5 drag; finger:
   *  long press, same as the board's cards and the reminders list. Same
   *  endpoint as the board (PATCH .../move): same lane (primary assignee) AND
   *  same priority tier only — a drop outside that range 400s, the screen
   *  does not optimistically reorder, so it reads as a snap-back + toast.
   *  Omit to render without the handle at all (e.g. no onReorder → not drag-
   *  gable) — every current call site passes it. */
  onReorder?: (item: WorkItem, beforeId: string | null) => void;
  onMarkDone: (item: WorkItem) => void;
  onBlockedClick: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail | 'loading'>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  // A drag is never a click — set on the first move/long-press, cleared by
  // the next pointer-down, read by the row's onClickCapture.
  const dragged = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const carried = useRef<Carried | null>(null);
  const [touchId, setTouchId] = useState<string | null>(null);

  const canReorder = canEdit && !!onReorder;

  const sorted = [...items].sort((a, b) => {
    const aUn = a.assignee === null, bUn = b.assignee === null;
    if (aUn !== bUn) return aUn ? -1 : 1; // unassigned first
    const rank = (p: WorkItem['priority']) => (p === 'urgent' ? 0 : p === 'high' ? 1 : 2);
    const pr = rank(a.priority) - rank(b.priority);
    if (pr !== 0) return pr;
    // A manual drag (decision 6) sets sort_index scoped to this exact
    // (assignee, priority) pair — same precedence as the board's own
    // byLane comparator (WorkItemsBoard.tsx): nulls (never dragged) sort
    // last, otherwise ascending. Falls through to due_date/created_at only
    // when neither side has ever been positioned.
    if (a.sort_index !== b.sort_index) {
      if (a.sort_index === null) return 1;
      if (b.sort_index === null) return -1;
      return a.sort_index - b.sort_index;
    }
    if (a.due_date !== b.due_date) return (a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1;
    return a.created_at < b.created_at ? 1 : -1;
  });

  function endDrag() {
    setDragId(null);
    setLanding(null);
  }

  /** The dragged row dropped back where it already is. */
  function samePlace(beforeId: string | null): boolean {
    const at = sorted.findIndex((r) => r.id === dragId);
    return at !== -1 && (sorted[at + 1]?.id ?? null) === beforeId;
  }

  function drop(beforeId: string | null) {
    const id = dragId;
    const unchanged = samePlace(beforeId);
    endDrag();
    if (id && !unchanged) {
      const item = sorted.find((r) => r.id === id);
      if (item) onReorder?.(item, beforeId);
    }
  }

  /** Where a finger at `p` would drop the carried row; null = off the list. */
  function touchLanding(p: DragPoint): Landing | null {
    const c = carried.current;
    const list = listRef.current;
    if (!c || !list || !inside(list.getBoundingClientRect(), p)) return null;
    return { beforeId: landingAboveIn(list, p.y, c.id, ID_ATTR) };
  }

  function follow(p: DragPoint) {
    const c = carried.current;
    if (!c) return;
    c.last = p;
    const dy = p.y - c.start.y + (c.scroller.scrollTop - c.scrollTop0);
    c.el.style.transform = `translateY(${dy}px)`;
    const spot = touchLanding(p);
    if (spot === null) return;
    setLanding((l) => (l?.beforeId === spot.beforeId ? l : spot));
  }

  function autoScroll() {
    const c = carried.current;
    if (!c) return;
    const r = c.scroller.getBoundingClientRect();
    const top = Math.max(r.top, 0) + 64;
    const bottom = Math.min(r.bottom, window.innerHeight) - 64;
    const step = c.last.y < top ? -Math.min(16, Math.ceil((top - c.last.y) / 4))
      : c.last.y > bottom ? Math.min(16, Math.ceil((c.last.y - bottom) / 4)) : 0;
    if (step !== 0) {
      c.scroller.scrollTop += step;
      follow(c.last);
    }
    c.raf = requestAnimationFrame(autoScroll);
  }

  function release() {
    const c = carried.current;
    if (!c) return;
    cancelAnimationFrame(c.raf);
    c.el.style.transform = '';
    carried.current = null;
    setTouchId(null);
  }

  const longPress = useLongPressDrag({
    onStart: (id, p) => {
      const list = listRef.current;
      const el = list?.querySelector<HTMLElement>(`[${ID_ATTR}="${id}"]`);
      if (!list || !el) return;
      const scroller = scrollParent(list);
      carried.current = { id, el, start: p, last: p, scroller, scrollTop0: scroller.scrollTop, raf: 0 };
      dragged.current = true;
      setDragId(id);
      setTouchId(id);
      follow(p);
      carried.current.raf = requestAnimationFrame(autoScroll);
    },
    onMove: follow,
    onDrop: (p) => {
      const spot = touchLanding(p);
      release();
      if (spot) drop(spot.beforeId);
      else endDrag();
    },
    onCancel: () => {
      release();
      endDrag();
    },
  }, { enabled: canReorder });

  const here = landing && !samePlace(landing.beforeId) ? landing : null;

  function toggleExpand(item: WorkItem) {
    const next = expanded === item.id ? null : item.id;
    setExpanded(next);
    if (next && !details[item.id]) {
      setDetails((d) => ({ ...d, [item.id]: 'loading' }));
      void fetchDetail(kind, item.id).then((detail) => setDetails((d) => ({ ...d, [item.id]: detail })));
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-white p-10 text-center text-sm text-ink-ghost">
        אין פריטים פעילים.
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="overflow-hidden rounded-2xl border border-line bg-white"
      onDragOver={(e) => {
        if (!canReorder || !dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const beforeId = landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR);
        setLanding((l) => (l?.beforeId === beforeId ? l : { beforeId }));
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setLanding(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (canReorder && dragId) drop(landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR));
      }}
    >
      <div className="grid grid-cols-[1fr_230px_200px] gap-3 border-b border-line bg-surface-2 px-4 py-2.5 ps-[26px] text-[12px] font-bold text-ink-3">
        <span>משימה / תקלה</span>
        <span>נוצר</span>
        <span>אחראי</span>
      </div>
      {sorted.map((item) => {
        const isOpen = expanded === item.id;
        const detail = details[item.id];
        return (
          <div key={`${item.kind}:${item.id}`}>
            <div
              data-work-row-id={item.id}
              role="button"
              tabIndex={0}
              draggable={canReorder && !longPress.holding}
              onPointerDown={() => { dragged.current = false; }}
              onTouchStart={(e) => longPress.onTouchStart(item.id, e)}
              onContextMenu={(e) => { if (longPress.holding) e.preventDefault(); }}
              onDragStart={(e) => {
                // A custom type, so a stray drop into a text field types nothing.
                e.dataTransfer.setData('application/x-work-item-row', item.id);
                e.dataTransfer.effectAllowed = 'move';
                dragged.current = true;
                setDragId(item.id);
              }}
              onDragEnd={endDrag}
              onClickCapture={(e) => {
                if (!dragged.current) return;
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={() => toggleExpand(item)}
              onKeyDown={(e) => { if (e.key === 'Enter') toggleExpand(item); }}
              className={cn(
                'wb-handle wb-handle-row relative grid grid-cols-[1fr_230px_200px] items-center gap-3 border-b border-line-soft px-4 py-[11px] ps-[26px] pe-[34px] transition-colors last:border-b-0',
                item.priority !== 'normal' && WORK_PRIORITY_CARD[item.priority],
                WORK_PRIORITY_ROW_HOVER[item.priority],
                canReorder ? 'cursor-grab select-none active:cursor-grabbing [-webkit-touch-callout:none]' : 'cursor-pointer',
                dragId === item.id && touchId !== item.id && 'opacity-50',
                touchId === item.id && 'relative z-30 shadow-[0_10px_22px_-8px_rgba(15,23,42,0.18)] transition-none',
                here?.beforeId === item.id && 'ring-2 ring-brand/40',
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {item.blocked && (
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={(e) => { e.stopPropagation(); onBlockedClick(item); }}
                    title={item.blocked_reason ?? undefined}
                    className="shrink-0 rounded-md bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700"
                  >
                    תקוע
                  </button>
                )}
                <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">{item.title}</span>
              </span>
              <span className="truncate text-[11px] text-ink-ghost">
                {item.is_from_resident ? (
                  <span className="text-[#0C7A37]">נוצר ע״י דייר — דירה {item.source_apartment ?? '—'} · <span className="font-num" dir="ltr">{fmtCreated(item.created_at)}</span></span>
                ) : (
                  <>נוצר ע״י {item.created_by_name ?? '—'} · <span className="font-num" dir="ltr">{fmtCreated(item.created_at)}</span></>
                )}
              </span>

              {item.assignee === null ? (
                <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
                  <PrimaryAssigneePicker
                    value={null}
                    employees={employees}
                    suppliers={suppliers}
                    onChange={(a) => onAssign(item, a)}
                    disabled={!canEdit}
                    trigger={
                      <span className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-line-strong bg-white px-3.5 py-1 text-[12.5px] font-semibold text-ink-2 transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand">
                        <UserPlus className="h-3.5 w-3.5" />
                        ללא שיוך
                      </span>
                    }
                  />
                </span>
              ) : (
                <span onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-2">
                  <PrimaryAssigneePicker
                    value={item.assignee}
                    employees={employees}
                    suppliers={suppliers}
                    onChange={(a) => onAssign(item, a)}
                    disabled={!canEdit}
                    trigger={
                      <span className="flex min-w-0 items-center gap-1.5 rounded-full py-0.5 text-[13px] font-semibold text-ink-2 hover:bg-row-hover">
                        <span
                          className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white', item.assignee.kind === 'supplier' && 'text-white')}
                          style={{ background: item.assignee.kind === 'user' ? avatarColorFor(item.assignee.id) : '#16A34A' }}
                        >
                          {item.assignee.display_name.slice(0, 1)}
                        </span>
                        <span className="min-w-0 truncate">{item.assignee.display_name}</span>
                      </span>
                    }
                  />
                  <AssigneeAvatarStack assignees={item.assignees} primary={item.assignee} />
                </span>
              )}

              {canEdit && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute end-10 top-1/2 flex -translate-y-1/2 gap-0.5 rounded-lg border border-line bg-white p-[3px] opacity-0 shadow-[0_5px_14px_rgba(20,28,50,0.14)] transition-opacity hover:opacity-100 [div:hover>&]:opacity-100"
                >
                  <button type="button" title="סמן כבוצע" disabled={item.status_v2 === 'closed'} onClick={() => onMarkDone(item)} className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-[#E9FBF0] hover:text-[#0C7A37] disabled:opacity-40">
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="עריכה" onClick={() => onOpen(item)} className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-row-hover hover:text-ink">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="מחיקה" onClick={() => onDelete(item)} className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-[#FEEFEF] hover:text-[#B01B20]">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {!item.blocked && (
                    <button type="button" title="סמן כתקוע" onClick={() => onBlockedClick(item)} className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-[#FEEFEF] hover:text-[#B01B20]">
                      <AlertOctagon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}

              <ChevronDown className={cn('absolute end-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-ink-ghost transition-transform', isOpen && 'rotate-180 text-brand')} />
            </div>

            {isOpen && (
              <div className="border-b border-line-soft bg-surface-2 px-[26px] pb-[18px] pt-3">
                {detail === 'loading' || !detail ? (
                  <p className="text-[13px] text-ink-ghost">טוען…</p>
                ) : (
                  <div className="flex flex-wrap gap-11 pt-1">
                    <div className="max-w-[520px]">
                      <b className="mb-1.5 block text-[11.5px] font-bold text-ink-3">תיאור</b>
                      <p className="text-[13.5px] leading-[1.6] text-ink-2">{detail.description || 'אין תיאור.'}</p>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {detail.location && (
                          <span className="rounded-full border border-line bg-white px-3 py-1 text-[12px] font-semibold text-ink-2">
                            מיקום: {detail.location}
                          </span>
                        )}
                        <span
                          className={cn(
                            'rounded-full border px-3 py-1 text-[12px] font-semibold',
                            item.priority === 'urgent' ? 'border-[#F8D2D3] bg-[#FEEFEF] text-[#B01B20]'
                              : item.priority === 'high' ? 'border-[#FBE4B5] bg-[#FFF6E6] text-[#945700]'
                                : 'border-line bg-white text-ink-2',
                          )}
                        >
                          דחיפות: {WORK_PRIORITY_LABEL[item.priority]}
                        </span>
                      </div>
                    </div>
                    {kind === 'issue' && (
                      <div>
                        <b className="mb-1.5 block text-[11.5px] font-bold text-ink-3">תמונות</b>
                        {detail.images.length > 0 ? (
                          <div className="flex gap-2">
                            {detail.images.map((path) => {
                              const src = `/api/files/issue-attachments/${path}`;
                              return (
                                <button
                                  key={path}
                                  type="button"
                                  onClick={() => setLightbox(src)}
                                  className="grid h-[74px] w-[74px] place-items-center overflow-hidden rounded-[10px] border border-line bg-line-soft text-ink-ghost transition-transform hover:scale-[1.04]"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={src} alt="תמונת תקלה" className="h-full w-full object-cover" />
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-2 rounded-[10px] border-[1.5px] border-dashed border-line-strong px-4 py-2 text-[12.5px] font-medium text-ink-ghost">
                            <Camera className="h-[18px] w-[18px]" />
                            אין תמונות מצורפות
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {here && here.beforeId === null && sorted.some((r) => r.id !== dragId) && (
        <div aria-hidden className="h-1 rounded-full bg-brand/40" />
      )}
      <ImageLightbox open={lightbox !== null} src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
