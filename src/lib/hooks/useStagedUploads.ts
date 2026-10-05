'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

// The upload engine behind every "קבצים מצורפים" picker: each picked file is
// validated (the same rules the server enforces), uploaded AT ONCE to
// `uploadUrl` as a STAGED row with progress, and removed with its X (DELETE on
// `${deleteUrl}/<id>`, which also aborts an in-flight upload). The parent only
// keeps the list and sends the ids of the finished uploads with its submit.
//
// Shared by the WhatsApp / finance AttachmentPicker and the reminder panel's
// ReminderAttachments — one engine, two looks.

/** What may be attached and how it is validated. */
export interface AttachmentPolicy {
  /** `accept` attribute of the file input. */
  accept: string;
  /** Helper line under the dropzone. */
  helpText: (maxFiles: number) => string;
  /** Per-file rule (type / MIME / size) — Hebrew error or null. */
  validateFile: (file: { name: string; size: number; type: string }) => string | null;
  /** Set-level rule (count / total) for adding `next` on top of `existing`. */
  validateSet: (existing: { size: number }[], next: { size: number }[], maxFiles: number) => string | null;
  /** The MIME to record for a file (canonical for its extension, else the browser's). */
  mimeOf: (file: { name: string; type: string }) => string;
}

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
  /** The staged row id once uploaded (wa_campaign_attachments /
   *  wa_message_attachments / fin_documents / user_reminder_attachments). */
  attachmentId?: string;
  /** The proxy url of the staged file, when the upload route returns one. */
  url?: string;
  error?: string;
  /** The upload failed on the network (not a refusal) — the same file may be
   *  sent again with retry(). */
  retryable?: boolean;
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

export function useStagedUploads({
  items,
  onChange,
  maxFiles,
  uploadUrl,
  deleteUrl = uploadUrl,
  policy,
  describeError = (_name, err) => err,
}: {
  items: StagedAttachment[];
  onChange: (next: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[])) => void;
  /** Cap for THIS screen. */
  maxFiles: number;
  /** POST endpoint that stages one file. */
  uploadUrl: string;
  /** Base for DELETE `${deleteUrl}/<id>` (defaults to uploadUrl). */
  deleteUrl?: string;
  policy: AttachmentPolicy;
  /** How a pick-time refusal is toasted (default: the policy's message as is). */
  describeError?: (fileName: string, error: string) => string;
}) {
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  // The picked File of every row that may still need its bytes (upload / retry).
  const files = useRef(new Map<string, File>());

  // Abort whatever is still in flight when the picker goes away.
  useEffect(() => {
    const map = xhrs.current;
    const picked = files.current;
    return () => { map.forEach((x) => x.abort()); map.clear(); picked.clear(); };
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
      let body: { id?: string; url?: string; error?: string } = {};
      try { body = JSON.parse(xhr.responseText) as { id?: string; url?: string; error?: string }; } catch { /* non-json */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.id) {
        files.current.delete(item.localId);
        patch(item.localId, {
          status: 'done', progress: 100, attachmentId: body.id,
          ...(typeof body.url === 'string' ? { url: body.url } : {}),
        });
      } else {
        files.current.delete(item.localId);
        const msg = body.error || (xhr.status === 413 ? 'הקובץ גדול מדי לשרת' : `העלאה נכשלה (HTTP ${xhr.status})`);
        patch(item.localId, { status: 'error', error: msg, retryable: false });
        toast.error(msg);
      }
    };
    xhr.onerror = () => {
      xhrs.current.delete(item.localId);
      patch(item.localId, { status: 'error', error: 'העלאה נכשלה — בעיית רשת', retryable: true });
      toast.error('העלאת הקובץ נכשלה');
    };
    xhr.onabort = () => { xhrs.current.delete(item.localId); };
    xhr.open('POST', uploadUrl);
    xhr.withCredentials = true;
    xhr.send(fd);
  }

  function addFiles(list: FileList | File[]) {
    const picked = Array.from(list);
    if (picked.length === 0) return;
    // Every file is judged on its own — its type/MIME/size, then the set-level
    // rules (count, total) against the files ALREADY attached plus the ones
    // accepted earlier in this same pick. A selection that only partly fits
    // therefore adds what fits instead of being dropped whole.
    const accepted: { size: number }[] = items.filter((i) => i.status !== 'error').map((i) => ({ size: i.size }));
    let firstError: string | null = null;

    const additions: { item: StagedAttachment; file: File | null }[] = picked.map((file) => {
      const err =
        policy.validateFile({ name: file.name, size: file.size, type: file.type }) ??
        policy.validateSet(accepted, [{ size: file.size }], maxFiles);
      if (!err) accepted.push({ size: file.size });
      else if (!firstError) firstError = describeError(file.name, err);
      const item: StagedAttachment = {
        localId: newLocalId(),
        name: file.name,
        size: file.size,
        mime: policy.mimeOf({ name: file.name, type: file.type }),
        status: err ? 'error' : 'uploading',
        progress: 0,
        error: err ?? undefined,
      };
      return { item, file: err ? null : file };
    });
    if (firstError) toast.error(firstError);
    onChange((prev) => [...prev, ...additions.map((a) => a.item)]);
    for (const a of additions) {
      if (!a.file) continue;
      files.current.set(a.item.localId, a.file);
      upload(a.item, a.file);
    }
  }

  /** Send a network-failed file again (only rows marked `retryable`). */
  function retry(item: StagedAttachment) {
    const file = files.current.get(item.localId);
    if (!file || !item.retryable) return;
    patch(item.localId, { status: 'uploading', progress: 0, error: undefined, retryable: false });
    upload(item, file);
  }

  async function remove(item: StagedAttachment) {
    xhrs.current.get(item.localId)?.abort();
    xhrs.current.delete(item.localId);
    files.current.delete(item.localId);
    onChange((prev) => prev.filter((i) => i.localId !== item.localId));
    if (item.attachmentId) {
      try {
        await fetch(`${deleteUrl}/${item.attachmentId}`, { method: 'DELETE', credentials: 'include' });
      } catch { /* best-effort — the staged row is harmless */ }
    }
  }

  return { addFiles, remove, retry };
}
