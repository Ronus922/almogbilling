'use client';

import { Download, Pencil, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentWithSignedUrl } from '@/lib/types/documents';
import { fileMeta, formatBytes, formatDate } from './helpers';

interface Props {
  doc: DocumentWithSignedUrl;
  canEdit: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** A file tile — DESIGN §8/§9b card. Whole card opens/downloads the file (signed
 *  URL); rename/delete + a download affordance sit as an absolute sibling group. */
export function DocumentCard({ doc, canEdit, onOpen, onRename, onDelete }: Props) {
  const { Icon, tone } = fileMeta(doc.mime_type);
  const meta = [formatBytes(doc.size_bytes), formatDate(doc.created_at), doc.uploaded_by_name]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-white p-4 pe-20 text-start shadow-soft-xs transition-colors hover:border-line-strong hover:bg-row-hover cursor-pointer"
      >
        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tone}`}>
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{doc.file_name}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-3">{meta}</span>
        </span>
      </button>

      <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onOpen}
                aria-label="פתיחה / הורדה"
                className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-blue-50 hover:text-blue-600"
              />
            }
          >
            <Download className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>פתיחה / הורדה</TooltipContent>
        </Tooltip>

        {canEdit && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
    </div>
  );
}
