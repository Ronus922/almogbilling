'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { X, UploadCloud, Check, Loader2, Trash2, AlertCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { ALLOWED_DOC_TYPES, MAX_DOC_SIZE_BYTES } from '@/lib/constants/documents';
import { fileMeta, formatBytes, documentErrorMessage } from './helpers';

interface Props {
  open: boolean;
  /** Destination folder (null = root / unfiled). */
  folderId: string | null;
  folderName: string;
  /** Files staged from a page-level drop (consumed once on open). */
  initialFiles?: File[];
  onOpenChange: (o: boolean) => void;
  onUploaded: () => void;
}

type Status = 'pending' | 'uploading' | 'done' | 'error';
interface Item {
  id: string;
  file: File;
  status: Status;
  error?: string;
}

/** Client-side pre-check mirroring the server allowlist (DESIGN §13 — clear errors). */
function precheck(file: File): string | null {
  if (!ALLOWED_DOC_TYPES.includes(file.type)) return documentErrorMessage('invalid_file_type');
  if (file.size > MAX_DOC_SIZE_BYTES) return documentErrorMessage('file_too_large');
  return null;
}

export function UploadPanel({
  open,
  folderId,
  folderName,
  initialFiles,
  onOpenChange,
  onUploaded,
}: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploading = items.some((i) => i.status === 'uploading');
  const pendingCount = items.filter((i) => i.status === 'pending').length;

  // Seed staged files on open (from a page drop) and reset otherwise.
  useEffect(() => {
    if (open) {
      setItems(toItems(initialFiles ?? []));
      setDragging(false);
    } else {
      setItems([]);
    }
    // initialFiles is a fresh array per open; keying on `open` is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toItems(files: File[]): Item[] {
    return files.map((file) => {
      const err = precheck(file);
      return {
        id: globalThis.crypto?.randomUUID?.() ?? `${file.name}-${file.size}-${file.lastModified}`,
        file,
        status: err ? ('error' as const) : ('pending' as const),
        error: err ?? undefined,
      };
    });
  }

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length) setItems((prev) => [...prev, ...toItems(arr)]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  useEscapeKey(open, () => requestClose());

  function requestClose() {
    if (uploading) return;
    onOpenChange(false);
  }

  async function handleUpload() {
    // Retry errored items too (reset to pending), then upload anything not done.
    const targets = items.filter((i) => i.status !== 'done');
    if (!targets.length || uploading) return;

    setItems((prev) =>
      prev.map((i) => (i.status !== 'done' ? { ...i, status: 'uploading', error: undefined } : i)),
    );

    let ok = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const fd = new FormData();
        fd.append('file', target.file);
        if (folderId) fd.append('folder_id', folderId);

        const res = await fetch('/api/documents', {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(documentErrorMessage(data.error));

        ok += 1;
        setItems((prev) => prev.map((i) => (i.id === target.id ? { ...i, status: 'done' } : i)));
      } catch (e) {
        failed += 1;
        setItems((prev) =>
          prev.map((i) =>
            i.id === target.id ? { ...i, status: 'error', error: (e as Error).message } : i,
          ),
        );
      }
    }

    if (ok > 0) onUploaded();

    if (failed === 0) {
      toast.success(ok === 1 ? 'הקובץ הועלה' : `${ok} קבצים הועלו`);
      onOpenChange(false);
    } else if (ok > 0) {
      toast.error(`${ok} הועלו, ${failed} נכשלו`);
    } else {
      toast.error('העלאת הקבצים נכשלה');
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">העלאת קבצים</SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">יעד: {folderName}</p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              disabled={uploading}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="קבצים להעלאה" icon={UploadCloud} iconTone="blue">
            <div className="space-y-4 py-2">
              {/* Dropzone */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
                }}
                className={cn(
                  'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
                  dragging ? 'border-brand bg-brand-soft/60' : 'border-line-strong bg-surface-2 hover:border-brand hover:bg-brand-soft/40',
                )}
              >
                <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-brand">
                  <UploadCloud className="h-5 w-5" />
                </span>
                <span className="text-sm font-semibold text-ink">גרור קבצים או לחץ לבחירה</span>
                <span className="text-xs text-ink-3">עד 25MB לקובץ · תמונות, PDF, Office, טקסט</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />

              {/* Staged list */}
              {items.length === 0 ? (
                <p className="py-2 text-center text-xs text-slate-400">לא נבחרו קבצים עדיין.</p>
              ) : (
                <div className="space-y-2">
                  {items.map((item) => {
                    const { Icon, tone } = fileMeta(item.file.type);
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 rounded-lg border border-line bg-white p-3"
                      >
                        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', tone)}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{item.file.name}</div>
                          <div className="text-xs text-ink-3">
                            <span className="font-num tabular-nums">{formatBytes(item.file.size)}</span>
                            {item.status === 'error' && item.error && (
                              <span className="text-rose-600"> · {item.error}</span>
                            )}
                            {item.status === 'done' && <span className="text-emerald-600"> · הועלה</span>}
                          </div>
                        </div>
                        <div className="shrink-0">
                          {item.status === 'uploading' && (
                            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                          )}
                          {item.status === 'done' && <Check className="h-4 w-4 text-emerald-600" />}
                          {item.status === 'error' && <AlertCircle className="h-4 w-4 text-rose-600" />}
                          {(item.status === 'pending' || item.status === 'error') && !uploading && (
                            <button
                              type="button"
                              onClick={() => removeItem(item.id)}
                              aria-label="הסר"
                              className="ms-1 rounded-lg p-1 text-ink-3 transition-colors hover:bg-slate-100 hover:text-ink"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={handleUpload}
          saveDisabled={uploading || items.filter((i) => i.status !== 'done').length === 0}
          saveLabel={
            uploading
              ? 'מעלה…'
              : pendingCount > 0
                ? `העלה (${items.filter((i) => i.status !== 'done').length})`
                : 'העלה'
          }
        />
      </SheetContent>
    </Sheet>
  );
}
