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

import { useState } from 'react';
import { AlertOctagon, ChevronDown, Camera, Check, Pencil, Trash2, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WORK_PRIORITY_CARD, WORK_PRIORITY_ROW_HOVER, WORK_PRIORITY_LABEL, avatarColorFor } from '@/lib/constants/workItems';
import { AssigneeAvatarStack } from './AssigneeAvatarStack';
import { PrimaryAssigneePicker } from './PrimaryAssigneePicker';
import { ImageLightbox } from '@/components/issues/ImageLightbox';
import type { WorkItem, WorkItemKind } from '@/lib/types/workItems';

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

export function WorkListTable({
  kind,
  items,
  canEdit,
  employees,
  suppliers,
  onOpen,
  onAssign,
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
  onMarkDone: (item: WorkItem) => void;
  onBlockedClick: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail | 'loading'>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  const sorted = [...items].sort((a, b) => {
    const aUn = a.assignee === null, bUn = b.assignee === null;
    if (aUn !== bUn) return aUn ? -1 : 1; // unassigned first
    const rank = (p: WorkItem['priority']) => (p === 'urgent' ? 0 : p === 'high' ? 1 : 2);
    const pr = rank(a.priority) - rank(b.priority);
    if (pr !== 0) return pr;
    if (a.due_date !== b.due_date) return (a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1;
    return a.created_at < b.created_at ? 1 : -1;
  });

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
    <div className="overflow-hidden rounded-2xl border border-line bg-white">
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
              role="button"
              tabIndex={0}
              onClick={() => toggleExpand(item)}
              onKeyDown={(e) => { if (e.key === 'Enter') toggleExpand(item); }}
              className={cn(
                'wb-handle wb-handle-row relative grid cursor-pointer grid-cols-[1fr_230px_200px] items-center gap-3 border-b border-line-soft px-4 py-[11px] ps-[26px] pe-[34px] transition-colors last:border-b-0',
                item.priority !== 'normal' && WORK_PRIORITY_CARD[item.priority],
                WORK_PRIORITY_ROW_HOVER[item.priority],
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
      <ImageLightbox open={lightbox !== null} src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
