'use client';

import { Folder, ChevronLeft, Pencil, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentFolderWithMeta } from '@/lib/types/documents';

interface Props {
  folder: DocumentFolderWithMeta;
  canEdit: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** A folder tile — DESIGN §8/§9b card. Whole card opens the folder; rename/delete
 *  sit as an absolute sibling group (a button can't nest buttons). */
export function FolderCard({ folder, canEdit, onOpen, onRename, onDelete }: Props) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-white p-4 pe-12 text-start shadow-soft-xs transition-colors hover:border-line-strong hover:bg-row-hover cursor-pointer"
      >
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
          <Folder className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{folder.name}</span>
          <span className="mt-0.5 block text-xs text-ink-3">
            <span className="font-num tabular-nums">{folder.document_count}</span> קבצים
            {folder.subfolder_count > 0 && (
              <>
                {' · '}
                <span className="font-num tabular-nums">{folder.subfolder_count}</span> תיקיות
              </>
            )}
          </span>
        </span>
        <ChevronLeft className="h-4 w-4 shrink-0 text-ink-ghost" />
      </button>

      {canEdit && (
        <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onRename}
                  aria-label="שינוי שם"
                  className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-slate-100 hover:text-ink"
                />
              }
            >
              <Pencil className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>שינוי שם</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="מחיקה"
                  className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-rose-50 hover:text-rose-600"
                />
              }
            >
              <Trash2 className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>מחיקה</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
