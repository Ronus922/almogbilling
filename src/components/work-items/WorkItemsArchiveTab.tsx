'use client';

// תקלות/משימות — archive tab (12/10/2026: one per screen, search + read +
// restore). No kind column — each screen's archive holds only its own kind.

import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { WorkItem } from '@/lib/types/workItems';

export function WorkItemsArchiveTab({
  items,
  canEdit,
  onRestore,
  onOpen,
}: {
  items: WorkItem[];
  canEdit: boolean;
  onRestore: (item: WorkItem) => void;
  onOpen: (item: WorkItem) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () => (q.trim() ? items.filter((i) => i.title.includes(q.trim())) : items),
    [items, q],
  );

  return (
    <div className="space-y-3">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="חיפוש בארכיון…"
        className="h-10 max-w-sm"
      />
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
            <TableRow className="bg-slate-50 hover:bg-slate-50">
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">כותרת</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">נסגר</TableHead>
              <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={3} className="py-10 text-center text-sm text-slate-400">הארכיון ריק</TableCell></TableRow>
            )}
            {filtered.map((item) => (
              <TableRow key={`${item.kind}:${item.id}`} className="h-12 border-b border-slate-100">
                <TableCell className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-900" onClick={() => onOpen(item)}>
                  {item.title}
                </TableCell>
                <TableCell className="px-4 py-3 text-sm text-slate-500">
                  {item.closed_at ? new Date(item.closed_at).toLocaleDateString('he-IL') : '—'}
                </TableCell>
                <TableCell className="px-4 py-3 text-end">
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => onRestore(item)}
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-semibold text-blue-700 hover:bg-blue-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      שחזור
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
