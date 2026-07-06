'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { toast } from 'sonner';
import { FileText, Upload, Download, Trash2, Loader2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Section } from './Section';
import { fileMeta, formatBytes, formatDate } from '@/components/documents/helpers';
import { cn } from '@/lib/utils';
import type { DocumentWithSignedUrl } from '@/lib/types/documents';

interface Props {
  debtorId: string;
  /** contacts:edit — gates upload + delete (viewer sees a read-only list). */
  canEdit: boolean;
}

const ACCEPT = '.pdf,.docx,.xlsx,.jpg,.jpeg,.png';
const MAX_BYTES = 10 * 1024 * 1024; // mirror of the API cap (client-side guard)

// Only the error codes this feature's routes return.
function errMsg(code: string | undefined): string {
  switch (code) {
    case 'invalid_file_type': return 'סוג קובץ לא נתמך (PDF, Word, Excel, JPG, PNG בלבד)';
    case 'file_too_large': return 'הקובץ גדול מדי (מקסימום 10MB)';
    case 'storage_not_configured': return 'האחסון אינו מוגדר — פנה למנהל המערכת';
    case 'upload_failed': return 'העלאת הקובץ נכשלה';
    default: return code ? `הפעולה נכשלה: ${code}` : 'הפעולה נכשלה';
  }
}

export function DocumentsSection({ debtorId, canEdit }: Props) {
  const [docs, setDocs] = useState<DocumentWithSignedUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentWithSignedUrl | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/debtors/${debtorId}/documents`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { documents: DocumentWithSignedUrl[] }) => { if (!cancelled) setDocs(j.documents); })
      .catch(() => { if (!cancelled) toast.error('טעינת המסמכים נכשלה'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debtorId]);

  // XHR (not fetch) so we get a real upload-progress percentage.
  const upload = useCallback((file: File) => {
    if (!canEdit || uploading) return;
    if (file.size > MAX_BYTES) { toast.error(errMsg('file_too_large')); return; }
    setUploading(true);
    setProgress(0);
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/debtors/${debtorId}/documents`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      if (xhr.status === 201) {
        try {
          const j = JSON.parse(xhr.responseText) as { document: DocumentWithSignedUrl };
          setDocs((prev) => [j.document, ...prev]); // optimistic prepend (list is desc)
          toast.success('המסמך הועלה');
        } catch { toast.error('הפעולה נכשלה'); }
      } else {
        let code: string | undefined;
        try { code = (JSON.parse(xhr.responseText) as { error?: string }).error; } catch { /* non-JSON */ }
        toast.error(errMsg(code));
      }
    };
    xhr.onerror = () => { setUploading(false); toast.error('העלאת הקובץ נכשלה'); };
    xhr.send(form);
  }, [canEdit, uploading, debtorId]);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload(file);
    e.target.value = ''; // allow re-selecting the same file
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (!canEdit) return;
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    setDocs((prev) => prev.filter((d) => d.id !== target.id)); // optimistic
    try {
      const res = await fetch(`/api/debtors/${debtorId}/documents/${target.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      toast.success('המסמך נמחק');
    } catch {
      setDocs((prev) => [target, ...prev]); // rollback
      toast.error('מחיקת המסמך נכשלה');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  return (
    <Section title="מסמכים" icon={FileText} iconTone="blue">
      <div className="space-y-3">
        {canEdit && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'rounded-xl border-2 border-dashed p-6 text-center transition-colors',
              dragOver ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-slate-50/50',
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              onChange={onPick}
              className="hidden"
              disabled={uploading}
            />
            {uploading ? (
              <div className="space-y-2">
                <div className="flex items-center justify-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" /> מעלה… {progress}%
                </div>
                <div className="mx-auto h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : (
              <>
                <Upload className="mx-auto mb-2 h-6 w-6 text-slate-400" />
                <p className="text-sm text-slate-600">גררו קובץ לכאן, או</p>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="mt-2 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                >
                  <Upload className="h-4 w-4" /> העלאת מסמך
                </button>
                <p className="mt-2 text-xs text-slate-400">PDF, Word, Excel, JPG, PNG · עד 10MB</p>
              </>
            )}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            <div className="h-[68px] rounded-xl bg-slate-100 animate-pulse" />
            <div className="h-[68px] rounded-xl bg-slate-100 animate-pulse" />
          </div>
        ) : docs.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">אין מסמכים עדיין.</p>
        ) : (
          <ul className="space-y-2">
            {docs.map((doc) => {
              const { Icon, tone } = fileMeta(doc.mime_type);
              const meta = [formatBytes(doc.size_bytes), formatDate(doc.created_at), doc.uploaded_by_name]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={doc.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
                  <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', tone)}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{doc.file_name}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">{meta}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <a
                            href={`/api/debtors/${debtorId}/documents/${doc.id}/download`}
                            aria-label="הורדה"
                            className="inline-flex items-center justify-center rounded-lg p-2 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                          />
                        }
                      >
                        <Download className="h-4 w-4" />
                      </TooltipTrigger>
                      <TooltipContent>הורדה</TooltipContent>
                    </Tooltip>
                    {canEdit && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(doc)}
                              aria-label="מחיקה"
                              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                            />
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </TooltipTrigger>
                        <TooltipContent>מחיקה</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את המסמך?</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleteTarget?.file_name}» יימחק לצמיתות מהאחסון. לא ניתן לשחזר.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? 'מוחק…' : 'מחק'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
