'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Download, Loader2, Paperclip, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/components/documents/helpers';
import {
  useStagedUploads, type AttachmentPolicy, type StagedAttachment,
} from '@/lib/hooks/useStagedUploads';
import {
  REMINDER_ATTACHMENT_ACCEPT,
  REMINDER_ATTACHMENT_LIMITS,
  reminderAttachmentExt,
  reminderAttachmentHelpText,
  reminderAttachmentMime,
  validateReminderAttachment,
  validateReminderAttachmentSet,
} from '@/lib/constants/reminderAttachments';
import type { UserReminderAttachmentView } from '@/lib/types/userReminders';

// "קבצים מצורפים" of the reminder panel — ref/Reminder Dialog (05/10/2026),
// DESIGN.md §26c. Saved files (`existing`) come first, then this session's
// uploads (`staged`, the useStagedUploads engine): uploading → progress bar +
// cancel, refused (type / size) → red row with X only, network failure → red
// row with "ניסיון חוזר" + X. Without edit permission: the list with download
// only — no dropzone, no delete.

const POLICY: AttachmentPolicy = {
  accept: REMINDER_ATTACHMENT_ACCEPT,
  helpText: reminderAttachmentHelpText,
  validateFile: validateReminderAttachment,
  validateSet: validateReminderAttachmentSet,
  mimeOf: (f) => reminderAttachmentMime(f.name) ?? f.type,
};

const UPLOAD_URL = '/api/user-reminders/attachments';

/** Type badge of a file row: the extension, coloured PDF / image / document. */
function typeBadge(name: string, mime: string): { label: string; tone: string } {
  const ext = reminderAttachmentExt(name);
  const label = (ext || 'FILE').toUpperCase().slice(0, 4);
  if (mime === 'application/pdf') return { label, tone: 'bg-rose-50 text-rose-700' };
  if (mime.startsWith('image/')) return { label, tone: 'bg-emerald-50 text-emerald-600' };
  return { label, tone: 'bg-brand-soft text-brand-text' };
}

/** dd/MM in the business time zone ("הועלה 18/06"). */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' })
    .format(new Date(t));
}

const ACTION_BTN =
  'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-slate-100 hover:text-ink disabled:opacity-50';
const DELETE_BTN =
  'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 disabled:opacity-50';

function FileRow({
  name, mime, error, children, meta,
}: {
  name: string;
  mime: string;
  error?: boolean;
  meta: ReactNode;
  children: ReactNode;
}) {
  const badge = typeBadge(name, mime);
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-white p-3',
        error ? 'border-red-400 bg-red-50' : 'border-line',
      )}
    >
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg font-num text-[10.5px] font-bold', badge.tone)}>
        {badge.label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-semibold text-ink" title={name}>{name}</span>
        {meta}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </li>
  );
}

function SavedMeta({ size, createdAt }: { size: number; createdAt: string }) {
  const date = shortDate(createdAt);
  return (
    <span className="text-xs text-slate-400">
      <span className="font-num tabular-nums" dir="ltr">{formatBytes(size)}</span>
      {date && <> · הועלה <span className="font-num tabular-nums">{date}</span></>}
    </span>
  );
}

export function ReminderAttachments({
  existing,
  loading = false,
  staged,
  onStagedChange,
  canEdit,
  disabled = false,
  onRemoveExisting,
}: {
  /** Files already saved with the reminder. */
  existing: UserReminderAttachmentView[];
  /** The saved files are still being fetched (edit mode). */
  loading?: boolean;
  /** This session's uploads — sent as attachment_ids on save. */
  staged: StagedAttachment[];
  onStagedChange: (next: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[])) => void;
  canEdit: boolean;
  disabled?: boolean;
  /** Delete a saved file (the parent confirms first). */
  onRemoveExisting: (file: UserReminderAttachmentView) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const remaining = Math.max(0, REMINDER_ATTACHMENT_LIMITS.maxFiles - existing.length);
  const { addFiles, remove, retry } = useStagedUploads({
    items: staged,
    onChange: onStagedChange,
    maxFiles: remaining,
    uploadUrl: UPLOAD_URL,
    policy: POLICY,
    describeError: (name, err) => `«${name}»: ${err}`,
  });

  // Rows that hold (or will hold) a file — a refused row does not count.
  const count = existing.length + staged.filter((s) => s.status !== 'error').length;
  const full = count >= REMINDER_ATTACHMENT_LIMITS.maxFiles;
  const blocked = disabled || full;
  const hasRows = existing.length > 0 || staged.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="text-base font-medium text-muted-foreground">קבצים מצורפים</Label>
        {count > 0 ? (
          <span className="font-num text-xs tabular-nums text-muted-foreground" dir="ltr">
            {count} / {REMINDER_ATTACHMENT_LIMITS.maxFiles}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">רשות</span>
        )}
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען קבצים…
        </p>
      )}

      {hasRows && (
        <ul className="flex flex-col gap-2">
          {existing.map((f) => (
            <FileRow key={f.id} name={f.original_name} mime={f.mime} meta={<SavedMeta size={f.size} createdAt={f.created_at} />}>
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                title="הורדה"
                aria-label={`הורדת ${f.original_name}`}
                className={ACTION_BTN}
              >
                <Download className="h-[17px] w-[17px]" />
              </a>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onRemoveExisting(f)}
                  disabled={disabled}
                  title="מחיקה"
                  aria-label={`מחיקת ${f.original_name}`}
                  className={DELETE_BTN}
                >
                  <Trash2 className="h-[17px] w-[17px]" />
                </button>
              )}
            </FileRow>
          ))}

          {staged.map((s) => {
            if (s.status === 'uploading') {
              return (
                <FileRow
                  key={s.localId}
                  name={s.name}
                  mime={s.mime}
                  meta={
                    <>
                      <span className="mt-1 block h-1 overflow-hidden rounded-sm bg-line" aria-hidden>
                        <i className="block h-full rounded-sm bg-brand transition-[width]" style={{ width: `${s.progress}%` }} />
                      </span>
                      <span className="text-xs text-slate-400">
                        מעלה… <span className="font-num tabular-nums">{s.progress}%</span>
                      </span>
                    </>
                  }
                >
                  <button
                    type="button"
                    onClick={() => void remove(s)}
                    title="ביטול"
                    aria-label={`ביטול העלאת ${s.name}`}
                    className={ACTION_BTN}
                  >
                    <X className="h-[17px] w-[17px]" />
                  </button>
                </FileRow>
              );
            }
            if (s.status === 'error') {
              return (
                <FileRow
                  key={s.localId}
                  name={s.name}
                  mime={s.mime}
                  error
                  meta={<span className="text-[12px] font-semibold text-red-500">{s.error} · לא הועלה</span>}
                >
                  {s.retryable && (
                    <button
                      type="button"
                      onClick={() => retry(s)}
                      disabled={disabled}
                      title="ניסיון חוזר"
                      aria-label={`ניסיון חוזר ${s.name}`}
                      className={ACTION_BTN}
                    >
                      <RotateCw className="h-[17px] w-[17px]" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(s)}
                    title="הסרה"
                    aria-label={`הסרת ${s.name}`}
                    className={DELETE_BTN}
                  >
                    <X className="h-[17px] w-[17px]" />
                  </button>
                </FileRow>
              );
            }
            return (
              <FileRow
                key={s.localId}
                name={s.name}
                mime={s.mime}
                meta={<SavedMeta size={s.size} createdAt={new Date().toISOString()} />}
              >
                {s.url && (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="הורדה"
                    aria-label={`הורדת ${s.name}`}
                    className={ACTION_BTN}
                  >
                    <Download className="h-[17px] w-[17px]" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => void remove(s)}
                  disabled={disabled}
                  title="מחיקה"
                  aria-label={`מחיקת ${s.name}`}
                  className={DELETE_BTN}
                >
                  <Trash2 className="h-[17px] w-[17px]" />
                </button>
              </FileRow>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        <>
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
              // Phones: the pill wraps to its own full-width row (w-full) so the
              // text keeps a readable width; from sm up it is one row, as in the ref.
              'flex w-full flex-wrap items-center gap-3.5 rounded-xl border-[1.5px] p-4 text-start transition-colors',
              dragging
                ? 'border-solid border-brand bg-brand-soft'
                : 'border-dashed border-brand-border bg-surface-2 hover:border-brand',
              blocked && 'cursor-not-allowed opacity-50 hover:border-brand-border',
            )}
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-brand-soft text-brand">
              <Paperclip className="h-5 w-5" />
            </span>
            <span className="flex min-w-40 flex-1 flex-col gap-0.5 text-sm font-semibold text-slate-700">
              {full
                ? `הגעת למקסימום ${REMINDER_ATTACHMENT_LIMITS.maxFiles} קבצים`
                : hasRows ? 'הוספת קבצים נוספים' : 'גררו קבצים לכאן'}
              <small className="text-xs font-normal text-slate-400">
                {full
                  ? 'הסר קובץ כדי לצרף אחר'
                  : hasRows ? 'גררו לכאן או בחרו מהמחשב' : reminderAttachmentHelpText()}
              </small>
            </span>
            <span className="flex h-[38px] w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border border-brand-border bg-white px-3.5 text-sm font-semibold text-brand-text sm:w-auto">
              <Plus className="h-4 w-4" /> בחירת קבצים
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept={REMINDER_ATTACHMENT_ACCEPT}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </>
      ) : (
        !loading && !hasRows && <p className="text-sm text-muted-foreground">אין קבצים מצורפים</p>
      )}
    </div>
  );
}
