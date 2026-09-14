'use client';

import { useEffect, useRef, useState } from 'react';
import { CloudUpload, Loader2, Paperclip, X, AlertCircle, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { fileMeta, formatBytes } from '@/components/documents/helpers';
import {
  WHATSAPP_ATTACHMENT_ACCEPT,
  WHATSAPP_ATTACHMENT_LIMITS,
  WHATSAPP_ATTACHMENT_TYPES_LABEL,
  attachmentExt,
  canonicalMime,
  formatMb,
  validateBroadcastAttachment,
  validateBroadcastAttachmentSet,
} from '@/lib/constants/whatsappAttachments';

// "קבצים מצורפים" under the message of the compose tab. Each picked file is
// validated (type / MIME / size / count / total — the same rules the server
// enforces), uploaded AT ONCE to POST /api/whatsapp/campaigns/attachments (a
// staged row, campaign_id NULL) with a progress bar, and removed with its X
// (DELETE, also aborts an in-flight upload). The parent only ever needs the
// ids of the finished uploads — they go in the campaign POST as attachment_ids.

export type StagedStatus = 'uploading' | 'done' | 'error';

export interface StagedAttachment {
  /** Local key (not the server id). */
  localId: string;
  name: string;
  size: number;
  mime: string;
  status: StagedStatus;
  /** 0..100 while uploading. */
  progress: number;
  /** wa_campaign_attachments.id once uploaded. */
  attachmentId?: string;
  error?: string;
}

/** Ids of the uploads that finished, in list (= send) order. */
export function readyAttachmentIds(items: StagedAttachment[]): string[] {
  return items.filter((i) => i.status === 'done' && i.attachmentId).map((i) => i.attachmentId as string);
}

export function isUploading(items: StagedAttachment[]): boolean {
  return items.some((i) => i.status === 'uploading');
}

function newLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `f-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

const HELP_TEXT = `${WHATSAPP_ATTACHMENT_TYPES_LABEL} · מסמכים עד ${formatMb(WHATSAPP_ATTACHMENT_LIMITS.kinds.document.maxBytes)}, תמונות/וידאו/אודיו עד ${formatMb(WHATSAPP_ATTACHMENT_LIMITS.kinds.image.maxBytes)} · עד ${WHATSAPP_ATTACHMENT_LIMITS.maxFiles} קבצים, סה״כ עד ${formatMb(WHATSAPP_ATTACHMENT_LIMITS.maxTotalBytes)}`;

export function AttachmentPicker({
  items,
  onChange,
  disabled = false,
}: {
  items: StagedAttachment[];
  onChange: (next: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[])) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());

  // Abort whatever is still in flight when the picker goes away.
  useEffect(() => {
    const map = xhrs.current;
    return () => { map.forEach((x) => x.abort()); map.clear(); };
  }, []);

  function patch(localId: string, changes: Partial<StagedAttachment>) {
    onChange((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...changes } : i)));
  }

  function upload(item: StagedAttachment, file: File) {
    const xhr = new XMLHttpRequest();
    xhrs.current.set(item.localId, xhr);
    const fd = new FormData();
    fd.append('file', file);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(item.localId, { progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      xhrs.current.delete(item.localId);
      let body: { id?: string; error?: string } = {};
      try { body = JSON.parse(xhr.responseText) as { id?: string; error?: string }; } catch { /* non-json */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.id) {
        patch(item.localId, { status: 'done', progress: 100, attachmentId: body.id });
      } else {
        const msg = body.error || (xhr.status === 413 ? 'הקובץ גדול מדי לשרת' : `העלאה נכשלה (HTTP ${xhr.status})`);
        patch(item.localId, { status: 'error', error: msg });
        toast.error(msg);
      }
    };
    xhr.onerror = () => {
      xhrs.current.delete(item.localId);
      patch(item.localId, { status: 'error', error: 'העלאה נכשלה — בעיית רשת' });
      toast.error('העלאת הקובץ נכשלה');
    };
    xhr.onabort = () => { xhrs.current.delete(item.localId); };
    xhr.open('POST', '/api/whatsapp/campaigns/attachments');
    xhr.withCredentials = true;
    xhr.send(fd);
  }

  function addFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (files.length === 0) return;
    // Every file is judged on its own — its type/MIME/size, then the
    // broadcast-level rules (count, total) against the files ALREADY attached
    // plus the ones accepted earlier in this same pick. A selection that only
    // partly fits therefore adds what fits instead of being dropped whole.
    const accepted: { size: number }[] = items.filter((i) => i.status !== 'error').map((i) => ({ size: i.size }));
    let firstError: string | null = null;

    const additions: { item: StagedAttachment; file: File | null }[] = files.map((file) => {
      const err =
        validateBroadcastAttachment({ name: file.name, size: file.size, type: file.type }) ??
        validateBroadcastAttachmentSet(accepted, [{ size: file.size }]);
      if (!err) accepted.push({ size: file.size });
      else if (!firstError) firstError = err;
      const item: StagedAttachment = {
        localId: newLocalId(),
        name: file.name,
        size: file.size,
        mime: canonicalMime(attachmentExt(file.name)) ?? file.type,
        status: err ? 'error' : 'uploading',
        progress: 0,
        error: err ?? undefined,
      };
      return { item, file: err ? null : file };
    });
    if (firstError) toast.error(firstError);
    onChange((prev) => [...prev, ...additions.map((a) => a.item)]);
    for (const a of additions) if (a.file) upload(a.item, a.file);
  }

  async function remove(item: StagedAttachment) {
    xhrs.current.get(item.localId)?.abort();
    xhrs.current.delete(item.localId);
    onChange((prev) => prev.filter((i) => i.localId !== item.localId));
    if (item.attachmentId) {
      try {
        await fetch(`/api/whatsapp/campaigns/attachments/${item.attachmentId}`, { method: 'DELETE', credentials: 'include' });
      } catch { /* best-effort — the staged row is harmless */ }
    }
  }

  // Files that count toward the broadcast (a rejected row does not).
  const attachedCount = items.filter((i) => i.status !== 'error').length;
  const full = attachedCount >= WHATSAPP_ATTACHMENT_LIMITS.maxFiles;
  const blocked = disabled || full;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-base font-medium text-muted-foreground">קבצים מצורפים</Label>
        {attachedCount > 0 && (
          <span className="font-num text-xs tabular-nums text-muted-foreground">
            {attachedCount}/{WHATSAPP_ATTACHMENT_LIMITS.maxFiles}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); if (!blocked) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!blocked && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        disabled={blocked}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-6 text-center transition-colors',
          dragging ? 'border-brand bg-brand-soft/60' : 'border-line-strong bg-surface-2 hover:border-brand hover:bg-brand-soft/40',
          blocked && 'cursor-not-allowed opacity-50 hover:border-line-strong hover:bg-surface-2',
        )}
      >
        <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand">
          <CloudUpload className="h-5 w-5" />
        </span>
        {/* Plural on purpose: the chat composer's paperclip (one file) is also
            labelled "צרף קובץ", and users took this one for it. */}
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Paperclip className="h-4 w-4" /> צרף קבצים
        </span>
        <span className="text-xs text-ink-3">
          {full
            ? `הגעת למקסימום ${WHATSAPP_ATTACHMENT_LIMITS.maxFiles} קבצים — הסר קובץ כדי לצרף אחר`
            : 'גרור קבצים לכאן או לחץ לבחירה (אפשר לבחור כמה קבצים יחד)'}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={WHATSAPP_ATTACHMENT_ACCEPT}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <p className="text-xs text-muted-foreground">{HELP_TEXT}</p>

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => {
            const { Icon, tone } = fileMeta(item.mime);
            return (
              <li
                key={item.localId}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-white p-3',
                  item.status === 'error' ? 'border-red-400 bg-red-50' : 'border-line',
                )}
              >
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', tone)}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800" title={item.name}>{item.name}</span>
                    <span className="shrink-0 font-num text-xs tabular-nums text-slate-500">{formatBytes(item.size)}</span>
                  </div>
                  {item.status === 'uploading' && (
                    <div className="flex items-center gap-2">
                      <Progress value={item.progress} className="flex-1" />
                      <span className="w-9 shrink-0 text-end font-num text-[11px] tabular-nums text-slate-500">{item.progress}%</span>
                    </div>
                  )}
                  {item.status === 'error' && item.error && (
                    <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {item.error}</p>
                  )}
                  {item.status === 'done' && (
                    <p className="inline-flex items-center gap-1 text-[12px] text-emerald-600"><Check className="h-3.5 w-3.5" /> הועלה</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {item.status === 'uploading' && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
                  {item.status === 'error' && <AlertCircle className="h-4 w-4 text-red-500" />}
                  <button
                    type="button"
                    onClick={() => void remove(item)}
                    disabled={disabled}
                    aria-label={`הסר ${item.name}`}
                    className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
