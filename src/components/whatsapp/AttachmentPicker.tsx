'use client';

import { useRef, useState } from 'react';
import { Camera, CloudUpload, Loader2, Paperclip, X, AlertCircle, Check } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { fileMeta, formatBytes } from '@/components/documents/helpers';
import {
  EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES,
  WHATSAPP_ATTACHMENT_ACCEPT,
  WHATSAPP_ATTACHMENT_LIMITS,
  WHATSAPP_ATTACHMENT_TYPES_LABEL,
  attachmentExt,
  canonicalMime,
  formatMb,
  validateBroadcastAttachment,
  validateBroadcastAttachmentSet,
} from '@/lib/constants/whatsappAttachments';
import {
  useStagedUploads, type AttachmentPolicy, type StagedAttachment,
} from '@/lib/hooks/useStagedUploads';

// The engine (validate → stage with progress → remove) lives in
// useStagedUploads; these re-exports keep the existing imports working.
export {
  isUploading, readyAttachmentIds, type AttachmentPolicy, type StagedAttachment,
} from '@/lib/hooks/useStagedUploads';

// "קבצים מצורפים" — the shared multi-file picker. Each picked file is validated
// (type / MIME / size / count / total — the same rules the server enforces),
// uploaded AT ONCE to `uploadUrl` as a STAGED row with a progress bar, and
// removed with its X (DELETE on `${deleteUrl}/<id>`, which also aborts an
// in-flight upload). The parent only ever needs the ids of the finished uploads
// and sends them with the submit as attachment_ids.
//
// Three screens use it, with different endpoints, caps and (for the finance
// receipts) a different file policy:
//   • broadcast   — /api/whatsapp/campaigns/attachments, up to
//                   WHATSAPP_ATTACHMENT_LIMITS.maxFiles (10)
//   • one message — /api/whatsapp/messages/attachments, up to
//                   WHATSAPP_MESSAGE_MAX_FILES (5)
//   • finance     — /api/finance/documents, up to 5, PDF/JPG/PNG only, with a
//                   camera button on phones (`policy` + `capture`)

export const WHATSAPP_ATTACHMENT_POLICY: AttachmentPolicy = {
  accept: WHATSAPP_ATTACHMENT_ACCEPT,
  helpText,
  validateFile: validateBroadcastAttachment,
  validateSet: validateBroadcastAttachmentSet,
  mimeOf: (f) => canonicalMime(attachmentExt(f.name)) ?? f.type,
};

function helpText(maxFiles: number, maxTotalBytes: number = WHATSAPP_ATTACHMENT_LIMITS.maxTotalBytes): string {
  return `${WHATSAPP_ATTACHMENT_TYPES_LABEL} · מסמכים עד ${formatMb(WHATSAPP_ATTACHMENT_LIMITS.kinds.document.maxBytes)}, תמונות/וידאו/אודיו עד ${formatMb(WHATSAPP_ATTACHMENT_LIMITS.kinds.image.maxBytes)} · עד ${maxFiles} קבצים, סה״כ עד ${formatMb(maxTotalBytes)}`;
}

/** The email channel of a broadcast: the same files, but one email must hold
 *  them all — the total is Gmail's 25MB (the server checks it again). */
export const EMAIL_BROADCAST_ATTACHMENT_POLICY: AttachmentPolicy = {
  ...WHATSAPP_ATTACHMENT_POLICY,
  helpText: (maxFiles) => helpText(maxFiles, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES),
  validateSet: (existing, next, maxFiles) =>
    validateBroadcastAttachmentSet(existing, next, maxFiles, EMAIL_ATTACHMENTS_MAX_TOTAL_BYTES),
};

export function AttachmentPicker({
  items,
  onChange,
  disabled = false,
  maxFiles = WHATSAPP_ATTACHMENT_LIMITS.maxFiles,
  uploadUrl = '/api/whatsapp/campaigns/attachments',
  deleteUrl = uploadUrl,
  policy = WHATSAPP_ATTACHMENT_POLICY,
  capture = false,
  label = 'קבצים מצורפים',
}: {
  items: StagedAttachment[];
  onChange: (next: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[])) => void;
  disabled?: boolean;
  /** Cap for THIS screen (default: the broadcast cap). */
  maxFiles?: number;
  /** POST endpoint that stages one file. */
  uploadUrl?: string;
  /** Base for DELETE `${deleteUrl}/<id>` (defaults to uploadUrl). */
  deleteUrl?: string;
  /** File rules of THIS screen (default: the WhatsApp policy). */
  policy?: AttachmentPolicy;
  /** Adds a phone-only "צלם" button that opens the camera (capture=environment). */
  capture?: boolean;
  label?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const { addFiles, remove } = useStagedUploads({ items, onChange, maxFiles, uploadUrl, deleteUrl, policy });

  // Files that count toward the broadcast (a rejected row does not).
  const attachedCount = items.filter((i) => i.status !== 'error').length;
  const full = attachedCount >= maxFiles;
  const blocked = disabled || full;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-base font-medium text-muted-foreground">{label}</Label>
        {attachedCount > 0 && (
          <span className="font-num text-xs tabular-nums text-muted-foreground">
            {attachedCount}/{maxFiles}
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
            ? `הגעת למקסימום ${maxFiles} קבצים — הסר קובץ כדי לצרף אחר`
            : 'גרור קבצים לכאן או לחץ לבחירה (אפשר לבחור כמה קבצים יחד)'}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={policy.accept}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {capture && (
        <>
          {/* Camera path (phones only) — same handler, capture opens the camera
              instead of the gallery. Pattern from issues/issue-form-panel.tsx. */}
          <input
            ref={cameraRef}
            type="file"
            hidden
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => cameraRef.current?.click()}
            disabled={blocked}
            className="w-full gap-2 sm:hidden"
          >
            <Camera className="h-4 w-4" /> צלם קבלה
          </Button>
        </>
      )}
      <p className="text-xs text-muted-foreground">{policy.helpText(maxFiles)}</p>

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
