'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  X, AlertTriangle, MapPin, User, Images, MessageSquare, Trash2, Send,
  UploadCloud, Loader2, Camera, Video, Bell,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section, SectionHint } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { ImageLightbox } from './ImageLightbox';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import {
  ISSUE_STATUSES, ISSUE_PRIORITIES,
  issueStatusLabel, issuePriorityLabel,
  ISSUE_ALLOWED_IMAGE_TYPES, ISSUE_MAX_IMAGE_SIZE_BYTES, ISSUE_MAX_IMAGES,
  ISSUE_ALLOWED_VIDEO_TYPES, ISSUE_MAX_VIDEO_SIZE_BYTES, ISSUE_MAX_VIDEOS,
} from '@/lib/constants/issues';
import type {
  Issue, IssueComment, IssueImage, IssuePriority, IssueStatus, IssueWithMeta,
} from '@/lib/types/issues';
import type { TargetType } from '@/lib/types/targets';
import type { AssigneeInput, SupplierOption } from '@/lib/types/assignee';
import { TargetField } from '@/components/targets/TargetField';
import { AssigneeSplitFields } from '@/components/assignee/AssigneeSplitFields';
import {
  RemindersSection, splitRemindAt, buildRemindersPayload, rowChannels, channelsFromGlobals,
  hasNewPastReminder, type ReminderRow,
} from '@/components/reminders/RemindersSection';
import { ChannelCards } from '@/components/notify/ChannelCards';
import {
  EMPTY_CHANNELS,
  channelsToSelection,
  type ChannelValue,
  type NotifyUserContact,
} from '@/lib/notify/selection';

interface Assignee {
  id: string;
  name: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
}

interface Props {
  open: boolean;
  /** null → create mode; an issue → edit mode. */
  issue: IssueWithMeta | null;
  canEdit: boolean;
  assignees: Assignee[];
  suppliers: SupplierOption[];
  currentUser: NotifyUserContact;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  /** Edit mode + canEdit: shows a delete button in the footer. The caller owns
   *  the confirmation dialog + the actual delete. */
  onDelete?: () => void;
}

interface FormState {
  title: string;
  description: string;
  priority: IssuePriority;
  status: IssueStatus;
  /** Mixed handlers: any combination of users + suppliers. */
  assignees: AssigneeInput[];
  resolution_notes: string;
  target_type: TargetType | null;
  target_id: string | null;
  /** Optional due date (migration 054) — surfaces the issue on the calendar. */
  due_date: string;
  due_time: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  priority: 'normal',
  status: 'open',
  assignees: [],
  resolution_notes: '',
  target_type: null,
  target_id: null,
  due_date: '',
  due_time: '',
};

function fromIssue(i: IssueWithMeta): FormState {
  return {
    title: i.title,
    description: i.description ?? '',
    priority: i.priority,
    status: i.status,
    assignees: i.assignees.map((a) => ({
      assignee_type: a.assignee_type,
      id: (a.user_id ?? a.supplier_id) as string,
    })),
    resolution_notes: i.resolution_notes ?? '',
    target_type: i.target_type,
    target_id: i.target_id,
    due_date: i.due_date ?? '',
    due_time: i.due_time ? i.due_time.slice(0, 5) : '',
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  title_required: 'כותרת היא שדה חובה',
  resolution_notes_required: 'יש להזין הערות טיפול לפני סימון התקלה כ"טופלה"',
  too_many_images: `ניתן לצרף עד ${ISSUE_MAX_IMAGES} תמונות`,
  too_many_videos: `ניתן לצרף עד ${ISSUE_MAX_VIDEOS} סרטונים`,
  reminder_in_past: 'לא ניתן לקבוע תזכורת בעבר',
};

function mapError(code: string | undefined, fallback: string): string {
  return (code && ERROR_MESSAGES[code]) || fallback;
}

// ── Media (images + videos) — one config drives both kinds ───────────────────
// Images and videos differ only in column/endpoint/caps/allowed-types and the
// tile element (<img> vs <video>). One config feeds the unified dropzone and the
// per-kind stage/upload handlers, keeping the two from drifting (iron rule #8/#10).
type MediaKind = 'image' | 'video';

interface MediaConfig {
  kind: MediaKind;
  endpoint: 'images' | 'videos';
  /** Key of the created item in the POST response ({ image } vs { video }). */
  respKey: 'image' | 'video';
  types: readonly string[];
  maxSize: number;
  max: number;
  title: string;
  subtitleSuffix: string;
  typeErr: string;
  sizeErr: string;
  maxErr: string;
}

const MEDIA: Record<MediaKind, MediaConfig> = {
  image: {
    kind: 'image', endpoint: 'images', respKey: 'image',
    types: ISSUE_ALLOWED_IMAGE_TYPES, maxSize: ISSUE_MAX_IMAGE_SIZE_BYTES, max: ISSUE_MAX_IMAGES,
    title: 'תמונות', subtitleSuffix: 'JPG / PNG / WebP · עד 5MB',
    typeErr: 'סוג קובץ לא נתמך (JPG / PNG / WebP בלבד)',
    sizeErr: 'הקובץ גדול מדי (עד 5MB)',
    maxErr: `ניתן לצרף עד ${ISSUE_MAX_IMAGES} תמונות`,
  },
  video: {
    kind: 'video', endpoint: 'videos', respKey: 'video',
    types: ISSUE_ALLOWED_VIDEO_TYPES, maxSize: ISSUE_MAX_VIDEO_SIZE_BYTES, max: ISSUE_MAX_VIDEOS,
    title: 'סרטונים', subtitleSuffix: 'MP4 / WebM / MOV · עד 50MB',
    typeErr: 'סוג קובץ לא נתמך (MP4 / WebM / MOV בלבד)',
    sizeErr: 'הסרטון גדול מדי (עד 50MB)',
    maxErr: `ניתן לצרף עד ${ISSUE_MAX_VIDEOS} סרטונים`,
  },
};

interface MediaTile {
  key: string;
  src: string | null;
  isVideo: boolean;
  onRemove: () => void;
}

interface MediaDropSectionProps {
  canAdd: boolean;
  canEdit: boolean;
  busy: boolean;
  imageCount: number;
  videoCount: number;
  /** Images + videos combined into one grid (each tile knows its own kind). */
  tiles: MediaTile[];
  /** One entry point for picker, camera AND drag&drop — the parent routes files
   *  to images[]/videos[] by MIME and enforces the per-kind caps. */
  onFiles: (files: FileList | null) => void;
  onOpenLightbox?: (src: string) => void;
}

/**
 * One unified dropzone for images + videos (ref: NewProblem.png). Files dropped
 * or picked here are split by MIME into images[]/videos[] upstream (onFiles);
 * this component is presentation + the pick/camera/drop entry points only. The
 * two caps (6 images / 3 videos) are still enforced in the parent handlers.
 */
function MediaDropSection({ canAdd, canEdit, busy, imageCount, videoCount, tiles, onFiles, onOpenLightbox }: MediaDropSectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const accept = [...MEDIA.image.types, ...MEDIA.video.types].join(',');

  function pick(files: FileList | null, el: HTMLInputElement | null) {
    onFiles(files);
    if (el) el.value = ''; // let the same file be re-picked
  }

  // Two caps rows below the dropzone (ref) — driven by MEDIA so they never drift.
  const limits = [
    { icon: Images, cfg: MEDIA.image, count: imageCount },
    { icon: Video, cfg: MEDIA.video, count: videoCount },
  ];

  return (
    <Section
      title="תמונות וסרטונים"
      icon={Images}
      iconTone="blue"
      headerSlot={
        canAdd ? (
          // Mobile only: shoot straight to the rear camera (photo or video).
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-blue-100 px-3 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-200 disabled:opacity-60 sm:hidden"
          >
            <Camera className="h-3.5 w-3.5" />
            צלם / הקלט
          </button>
        ) : undefined
      }
    >
      <div className="space-y-3 py-2">
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => pick(e.target.files, e.currentTarget)}
        />
        {/* Camera path — same handler + accept list, plus capture to open the camera. */}
        <input
          ref={cameraRef}
          type="file"
          accept={accept}
          capture="environment"
          className="hidden"
          onChange={(e) => pick(e.target.files, e.currentTarget)}
        />

        {/* Unified dropzone (DESIGN §28.5) — click to pick or drag&drop; MIME routes
            each file to images[]/videos[] upstream. */}
        <button
          type="button"
          disabled={!canAdd || busy}
          onClick={() => fileRef.current?.click()}
          onDragOver={canAdd ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
          onDragLeave={() => setDragOver(false)}
          onDrop={canAdd ? (e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); } : undefined}
          className={cn(
            'flex w-full flex-col items-center gap-2 rounded-[14px] border-2 border-dashed bg-[#fafbfd] p-[26px] text-center transition-colors',
            canAdd ? 'cursor-pointer border-[#d8e0ec] hover:border-[#93b4f0] hover:bg-[#f5f9ff]' : 'cursor-not-allowed border-slate-200 opacity-60',
            dragOver && 'border-[#93b4f0] bg-[#f5f9ff]',
          )}
        >
          <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[#e8f0ff] text-[#2563eb]">
            {busy ? <Loader2 className="h-[22px] w-[22px] animate-spin" /> : <UploadCloud className="h-[22px] w-[22px]" />}
          </span>
          {/* ref shows a blue title; DESIGN §28.5 fixes it at #334155 → DESIGN wins. */}
          <span className="text-[14px] font-semibold text-[#334155]">גררו לכאן קבצים או לחצו להעלאה</span>
          <span className="text-[12.5px] text-[#94a3b8]">תמונות וסרטונים יחד — שחררו בכל מקום באזור המקווקו</span>
        </button>

        {/* Two caps rows: one per kind (images 0/6 · videos 0/3). */}
        <div className="flex flex-col gap-1.5">
          {limits.map(({ icon: Icon, cfg, count }) => (
            <div
              key={cfg.kind}
              className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5"
            >
              <span className="flex items-center gap-1.5 text-xs text-slate-600">
                <Icon className="h-3.5 w-3.5 text-slate-400" />
                {cfg.title} · {cfg.subtitleSuffix}
              </span>
              <span dir="ltr" className="tabular-nums text-xs font-semibold text-slate-500">
                {count}/{cfg.max}
              </span>
            </div>
          ))}
        </div>

        {/* Combined tiles — images (lightbox) + videos (inline player). */}
        {tiles.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.key} className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                {t.src ? (
                  t.isVideo ? (
                    <video
                      src={t.src}
                      controls
                      preload="metadata"
                      className="h-full w-full bg-black object-cover"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={t.src}
                      alt="תמונת תקלה"
                      onClick={() => t.src && onOpenLightbox?.(t.src)}
                      className="h-full w-full cursor-zoom-in object-cover transition-transform group-hover:scale-105"
                    />
                  )
                ) : (
                  <div className="grid h-full w-full place-items-center text-slate-400">
                    {t.isVideo ? <Video className="h-5 w-5" /> : <Images className="h-5 w-5" />}
                  </div>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={t.onRemove}
                    aria-label={t.isVideo ? 'מחק סרטון' : 'מחק תמונה'}
                    className="absolute top-1 end-1 z-10 grid h-7 w-7 place-items-center rounded-md bg-slate-900/60 text-white opacity-0 transition-opacity hover:bg-rose-600 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

export function IssueFormPanel({ open, issue, canEdit, assignees, suppliers, currentUser, onOpenChange, onSaved, onDelete }: Props) {
  const isEdit = !!issue;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  // Global send channels (WhatsApp / email) — applied to the selected handlers.
  const [channels, setChannels] = useState<ChannelValue>(EMPTY_CHANNELS);
  // "אליי" self opt-in — the current user also receives the alert + reminders.
  const [self, setSelf] = useState(false);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [images, setImages] = useState<IssueImage[]>([]);
  const [videos, setVideos] = useState<IssueImage[]>([]);
  // Create mode has no issue id yet, so media is staged client-side and uploaded
  // right after the issue is created. `url` is an object URL for preview.
  const [stagedImages, setStagedImages] = useState<{ file: File; url: string }[]>([]);
  const [stagedVideos, setStagedVideos] = useState<{ file: File; url: string }[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [initialReminders, setInitialReminders] = useState<ReminderRow[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/issues/${id}`, { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as {
        issue?: Issue;
        comments?: IssueComment[];
        images?: IssueImage[];
        videos?: IssueImage[];
        reminders?: { id: string; remind_at: string; channel: string; channels: ReminderRow['channels'] | null }[];
      };
      setComments(Array.isArray(data.comments) ? data.comments : []);
      setImages(Array.isArray(data.images) ? data.images : []);
      setVideos(Array.isArray(data.videos) ? data.videos : []);
      const rem = (data.reminders ?? []).map((x) => {
        const { date, time } = splitRemindAt(x.remind_at);
        return { date, time, channels: rowChannels(x.channels, x.channel) };
      });
      setReminders(rem);
      setInitialReminders(rem);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (open) {
      const init = issue ? fromIssue(issue) : EMPTY_FORM;
      setForm(init);
      setInitial(init);
      setComments([]);
      setImages([]);
      setVideos([]);
      setStagedImages((prev) => { prev.forEach((s) => URL.revokeObjectURL(s.url)); return []; });
      setStagedVideos((prev) => { prev.forEach((s) => URL.revokeObjectURL(s.url)); return []; });
      setReminders([]);
      setInitialReminders([]);
      setCommentInput('');
      setTitleTouched(false);
      setSubmitting(false);
      setUploading(false);
      setChannels(EMPTY_CHANNELS);
      setSelf(false);
      if (issue) void loadDetail(issue.id);
    }
  }, [open, issue, loadDetail]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Fallback names for the picker chips (covers a soft-deleted supplier still
  // assigned in edit mode, absent from the active option lists).
  const knownNames = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const a of issue?.assignees ?? []) {
      const id = a.user_id ?? a.supplier_id;
      if (id && a.display_name) m[`${a.assignee_type}:${id}`] = a.display_name;
    }
    return m;
  }, [issue]);

  // Handler keys the global channels expand over. The server governs edit-mode
  // fan-out (filterAddedAssignees), so sending ALL current keys is safe — only
  // newly-added handlers are notified on PATCH.
  const assigneeKeys = useMemo(
    () => form.assignees.map((a) => `${a.assignee_type}:${a.id}`),
    [form.assignees],
  );

  const titleError = titleTouched && !form.title.trim() ? 'כותרת היא שדה חובה' : null;
  const resolutionMissing =
    form.status === 'resolved' && !form.resolution_notes.trim();

  const dirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(initial) ||
      JSON.stringify(reminders) !== JSON.stringify(initialReminders) ||
      channels.email || channels.whatsapp || self ||
      (!isEdit && (stagedImages.length > 0 || stagedVideos.length > 0)),
    [form, initial, reminders, initialReminders, channels, self, isEdit, stagedImages.length, stagedVideos.length],
  );
  const canSubmit = canEdit && !!form.title.trim() && !resolutionMissing && !submitting;

  useEscapeKey(open && !confirmCloseOpen && !lightbox, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting || uploading) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }
  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTitleTouched(true);
      if (resolutionMissing) toast.error('יש להזין הערות טיפול לסטטוס "טופלה"');
      return;
    }
    if (hasNewPastReminder(reminders, initialReminders)) {
      toast.error('לא ניתן לקבוע תזכורת בעבר');
      return;
    }
    const remindersPayload = buildRemindersPayload(reminders, channelsFromGlobals(channels), self);
    if (remindersPayload === null) {
      toast.error('תאריך תזכורת לא תקין');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        status: form.status,
        // Mixed handlers (users + suppliers) → entity_assignees junction.
        assignees: form.assignees,
        resolution_notes: form.resolution_notes.trim() || null,
        // Target is optional. A type without a value persists as no target.
        target_type: form.target_id ? form.target_type : null,
        target_id: form.target_id || null,
        // Optional due date / time (null when empty) — drives calendar visibility.
        due_date: form.due_date || null,
        due_time: form.due_time || null,
      };
      // Only send reminders array if it changed (replacement semantics — same as tasks).
      const remindersChanged =
        JSON.stringify(reminders) !== JSON.stringify(initialReminders);
      if (remindersChanged) body.reminders = remindersPayload;

      // Global channels expanded over the selected handlers → the recipient-keyed
      // selection the route consumes (IMMEDIATE send, handlers only). Edit fan-out
      // is filtered server-side. "אליי" is a reminder-only option (notify_owner),
      // so it does NOT add an immediate 'me' send here.
      body.notify = channelsToSelection(channels, assigneeKeys);

      const url = isEdit ? `/api/issues/${issue!.id}` : '/api/issues';
      const method = isEdit ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { issue?: { id: string }; error?: string };
      if (!r.ok) {
        throw new Error(mapError(data.error, isEdit ? 'עדכון התקלה נכשל' : 'יצירת התקלה נכשלה'));
      }

      // Create mode: attach any staged media to the freshly-created issue,
      // reusing the same endpoints the edit flow uses (one request per file).
      if (!isEdit && data.issue?.id) {
        const newId = data.issue.id;
        const pending: { file: File; endpoint: 'images' | 'videos'; noun: string }[] = [
          ...stagedImages.map((s) => ({ file: s.file, endpoint: 'images' as const, noun: 'תמונות' })),
          ...stagedVideos.map((s) => ({ file: s.file, endpoint: 'videos' as const, noun: 'סרטונים' })),
        ];
        const failed: Record<string, number> = {};
        for (const p of pending) {
          const fd = new FormData();
          fd.append('file', p.file);
          const ur = await fetch(`/api/issues/${newId}/${p.endpoint}`, {
            method: 'POST',
            credentials: 'include',
            body: fd,
          });
          if (!ur.ok) failed[p.noun] = (failed[p.noun] ?? 0) + 1;
        }
        for (const [noun, n] of Object.entries(failed)) {
          toast.warning(`התקלה נוצרה, אך ${n} ${noun} לא הועלו`);
        }
      }

      toast.success(isEdit ? 'התקלה עודכנה' : 'התקלה נוצרה');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // Per-kind state, so the generic media handlers below stay DRY across
  // images/videos (endpoints, caps and allowed-types come from MEDIA[kind]).
  const mediaState = {
    image: { uploaded: images, setUploaded: setImages, staged: stagedImages, setStaged: setStagedImages },
    video: { uploaded: videos, setUploaded: setVideos, staged: stagedVideos, setStaged: setStagedVideos },
  } as const;

  // Edit mode: upload each file to the issue immediately (one request per file →
  // D1 multiple). Skips over-cap / bad-type / oversize files with a toast each.
  async function uploadMedia(kind: MediaKind, files: FileList | File[] | null) {
    if (!issue) return;
    const cfg = MEDIA[kind];
    const st = mediaState[kind];
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    let room = cfg.max - st.uploaded.length;
    if (room <= 0) { toast.error(cfg.maxErr); return; }
    setUploading(true);
    try {
      for (const file of list) {
        if (room <= 0) { toast.error(cfg.maxErr); break; }
        if (!cfg.types.includes(file.type)) { toast.error(cfg.typeErr); continue; }
        if (file.size > cfg.maxSize) { toast.error(cfg.sizeErr); continue; }
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`/api/issues/${issue.id}/${cfg.endpoint}`, {
          method: 'POST', credentials: 'include', body: fd,
        });
        const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        const item = data[cfg.respKey] as IssueImage | undefined;
        if (!r.ok || !item) {
          toast.error(mapError(typeof data.error === 'string' ? data.error : undefined, 'ההעלאה נכשלה'));
          continue;
        }
        st.setUploaded((prev) => [...prev, item]);
        room -= 1;
      }
    } finally {
      setUploading(false);
    }
  }

  // Create mode: validate + stage files locally (no issue id to upload to yet).
  function stageMedia(kind: MediaKind, files: FileList | File[] | null) {
    const cfg = MEDIA[kind];
    const st = mediaState[kind];
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    let room = cfg.max - st.staged.length;
    if (room <= 0) { toast.error(cfg.maxErr); return; }
    for (const file of list) {
      if (room <= 0) { toast.error(cfg.maxErr); break; }
      if (!cfg.types.includes(file.type)) { toast.error(cfg.typeErr); continue; }
      if (file.size > cfg.maxSize) { toast.error(cfg.sizeErr); continue; }
      st.setStaged((prev) => [...prev, { file, url: URL.createObjectURL(file) }]);
      room -= 1;
    }
  }

  async function removeUploaded(kind: MediaKind, path: string) {
    if (!issue) return;
    const cfg = MEDIA[kind];
    const st = mediaState[kind];
    const prev = st.uploaded;
    st.setUploaded((curr) => curr.filter((m) => m.path !== path)); // optimistic
    try {
      const r = await fetch(`/api/issues/${issue.id}/${cfg.endpoint}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error('המחיקה נכשלה');
    } catch (e) {
      st.setUploaded(prev);
      toast.error((e as Error).message);
    }
  }

  function removeStagedMedia(kind: MediaKind, url: string) {
    mediaState[kind].setStaged((prev) => prev.filter((s) => s.url !== url));
    URL.revokeObjectURL(url);
  }

  function tilesFor(kind: MediaKind): MediaTile[] {
    const st = mediaState[kind];
    const isVideo = kind === 'video';
    return isEdit
      ? st.uploaded.map((m) => ({ key: m.path, src: m.signed_url, isVideo, onRemove: () => void removeUploaded(kind, m.path) }))
      : st.staged.map((s) => ({ key: s.url, src: s.url, isVideo, onRemove: () => removeStagedMedia(kind, s.url) }));
  }

  // Unified dropzone: split one drop/pick into image vs video subsets by MIME,
  // then route each to the existing per-kind handler (caps enforced there). Files
  // matching neither allowed list are rejected with one toast — no endpoint change.
  function onMediaFiles(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const imgs = list.filter((f) => (MEDIA.image.types as readonly string[]).includes(f.type));
    const vids = list.filter((f) => (MEDIA.video.types as readonly string[]).includes(f.type));
    if (list.length > imgs.length + vids.length) {
      toast.error('סוג קובץ לא נתמך (תמונה או סרטון בלבד)');
    }
    if (imgs.length) { if (isEdit) void uploadMedia('image', imgs); else stageMedia('image', imgs); }
    if (vids.length) { if (isEdit) void uploadMedia('video', vids); else stageMedia('video', vids); }
  }

  async function addComment() {
    const content = commentInput.trim();
    if (!content || !issue) return;
    try {
      const r = await fetch(`/api/issues/${issue.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error('הוספת תגובה נכשלה');
      const data = (await r.json()) as { comment: IssueComment };
      setComments((prev) => [...prev, data.comment]);
      setCommentInput('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const disabled = submitting || !canEdit;
  const mediaBusy = uploading || submitting;

  // Server media (edit) or staged previews (create) — one grid renders both.
  const imageCount = isEdit ? images.length : stagedImages.length;
  const videoCount = isEdit ? videos.length : stagedVideos.length;

  // A channel is offerable only if some selected recipient (handler / self) has
  // that contact detail — mirrors the server's silent-skip. Suppliers carry a
  // phone via mobile-or-phone (matches getSupplierNotifyContact).
  const emailAvailable =
    (self && currentUser.hasEmail) ||
    form.assignees.some((a) =>
      a.assignee_type === 'user'
        ? !!assignees.find((u) => u.id === a.id)?.hasEmail
        : !!suppliers.find((s) => s.id === a.id)?.email,
    );
  const phoneAvailable =
    (self && currentUser.hasPhone) ||
    form.assignees.some((a) =>
      a.assignee_type === 'user'
        ? !!assignees.find((u) => u.id === a.id)?.hasPhone
        : !!(suppliers.find((s) => s.id === a.id)?.mobile || suppliers.find((s) => s.id === a.id)?.phone),
    );

  // "אליי" is a reminder option — enabled only once a dated reminder exists.
  const hasDatedReminder = reminders.some((r) => !!r.date);

  // Global channel cards, rendered inside the "התראה ותזכורות" card (bare).
  const channelCards = (
    <ChannelCards
      value={channels}
      onChange={setChannels}
      disabled={disabled}
      hasHandler={assigneeKeys.length > 0}
      self={self}
      onSelfChange={setSelf}
      emailAvailable={emailAvailable}
      phoneAvailable={phoneAvailable}
      selfEnabled={hasDatedReminder}
      bare
    />
  );

  return (
    <>
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
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? 'עריכת תקלה' : 'תקלה חדשה'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'פרטי התקלה, מיקום, תמונות, שיוך וטיפול.'
                    : 'תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting || uploading}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              {/* Details */}
              <Section title="פרטי התקלה" icon={AlertTriangle} iconTone="rose">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="issue-title" className="text-base font-medium text-muted-foreground">
                      כותרת<span className="text-red-500"> *</span>
                    </Label>
                    <Input
                      id="issue-title"
                      value={form.title}
                      onChange={(e) => set('title', e.target.value)}
                      onBlur={() => setTitleTouched(true)}
                      disabled={disabled}
                      autoFocus={!isEdit}
                      placeholder="מה התקלה?"
                      className={cn('h-10', titleError && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                    />
                    {titleError && (
                      <p className="text-[12px] font-semibold text-red-500 text-right">⚠️ {titleError}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="issue-desc" className="text-base font-medium text-muted-foreground">תיאור</Label>
                    <Textarea
                      id="issue-desc"
                      value={form.description}
                      onChange={(e) => set('description', e.target.value)}
                      disabled={disabled}
                      className="min-h-24"
                      placeholder="פירוט התקלה (אופציונלי)"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">סטטוס</Label>
                      <Select value={form.status} onValueChange={(v) => { if (v) set('status', v as IssueStatus); }} disabled={disabled}>
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue>{(v: string | null) => (v ? issueStatusLabel(v as IssueStatus) : null)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {ISSUE_STATUSES.map((s) => (
                            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">דחיפות</Label>
                      <Select value={form.priority} onValueChange={(v) => { if (v) set('priority', v as IssuePriority); }} disabled={disabled}>
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue>{(v: string | null) => (v ? issuePriorityLabel(v as IssuePriority) : null)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {ISSUE_PRIORITIES.map((p) => (
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Optional due date / time — an issue with a due date shows on the calendar. */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="issue-due-date" className="text-base font-medium text-muted-foreground">תאריך יעד</Label>
                      <Input
                        id="issue-due-date"
                        type="date"
                        value={form.due_date}
                        onChange={(e) => set('due_date', e.target.value)}
                        disabled={disabled}
                        onClick={(e) => {
                          const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                          try { el.showPicker?.(); } catch { /* native fallback */ }
                        }}
                        className="h-10 cursor-pointer"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="issue-due-time" className="text-base font-medium text-muted-foreground">שעת יעד</Label>
                      <Input
                        id="issue-due-time"
                        type="time"
                        value={form.due_time}
                        onChange={(e) => set('due_time', e.target.value)}
                        disabled={disabled}
                        dir="ltr"
                        className="h-10 cursor-pointer tabular-nums"
                      />
                    </div>
                  </div>

                  {/* Resolution notes — shown when resolving/resolved. */}
                  {(form.status === 'resolved' || form.status === 'closed') && (
                    <div className="space-y-2">
                      <Label htmlFor="issue-resolution" className="text-base font-medium text-muted-foreground">
                        הערות טיפול{form.status === 'resolved' && <span className="text-red-500"> *</span>}
                      </Label>
                      <Textarea
                        id="issue-resolution"
                        value={form.resolution_notes}
                        onChange={(e) => set('resolution_notes', e.target.value)}
                        disabled={disabled}
                        className={cn('min-h-20', resolutionMissing && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                        placeholder="כיצד טופלה התקלה?"
                      />
                      {resolutionMissing && (
                        <p className="text-[12px] font-semibold text-red-500 text-right">
                          ⚠️ יש להזין הערות טיפול לסטטוס &quot;טופלה&quot;
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </Section>

              {/* Location / target */}
              <Section
                title="מיקום"
                icon={MapPin}
                iconTone="amber"
                headerSlot={<SectionHint>אופציונלי</SectionHint>}
              >
                <div className="py-2">
                  <TargetField
                    value={{ type: form.target_type, id: form.target_id }}
                    onChange={(t) => setForm((prev) => ({ ...prev, target_type: t.type, target_id: t.id }))}
                    disabled={disabled}
                  />
                </div>
              </Section>

              {/* Handlers — internal users + external suppliers as two pickers */}
              <Section
                title="גורם מטפל"
                icon={User}
                iconTone="violet"
                headerSlot={<SectionHint>אפשר לשלב את שניהם</SectionHint>}
              >
                <AssigneeSplitFields
                  users={assignees}
                  suppliers={suppliers}
                  value={form.assignees}
                  onChange={(next) => set('assignees', next)}
                  knownNames={knownNames}
                  disabled={disabled}
                />
              </Section>

              {/* Alert + reminders — one card. Reminders first; the channel cards
                  appear only once a reminder is added (they set its delivery). */}
              <Section title="התראה ותזכורות" icon={Bell} iconTone="amber">
                <div className="space-y-4 py-2">
                  <RemindersSection reminders={reminders} onChange={setReminders} disabled={disabled} bare />
                  {reminders.length > 0 && channelCards}
                </div>
              </Section>

              {/* Media — one unified dropzone; files route to images[]/videos[] by
                  MIME (onMediaFiles). Edit attaches immediately; create stages
                  locally and uploads right after the issue is made. */}
              <MediaDropSection
                canAdd={canEdit && (imageCount < MEDIA.image.max || videoCount < MEDIA.video.max)}
                canEdit={canEdit}
                busy={mediaBusy}
                imageCount={imageCount}
                videoCount={videoCount}
                tiles={[...tilesFor('image'), ...tilesFor('video')]}
                onFiles={onMediaFiles}
                onOpenLightbox={setLightbox}
              />

              {/* Comments — edit mode only */}
              {isEdit && (
                <Section title="תגובות" icon={MessageSquare} iconTone="slate">
                  <div className="space-y-3 py-2">
                    {comments.length === 0 && (
                      <p className="py-2 text-center text-xs text-slate-400">אין תגובות עדיין.</p>
                    )}
                    {comments.map((c) => (
                      <div key={c.id} className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-800">{c.author_name ?? 'משתמש'}</span>
                          <span dir="ltr" className="text-[11px] tabular-nums text-slate-400">
                            {new Date(c.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{c.content}</p>
                      </div>
                    ))}
                    <div className="relative">
                      <Textarea
                        value={commentInput}
                        onChange={(e) => setCommentInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void addComment(); }
                        }}
                        placeholder="הוסף תגובה… (Ctrl+Enter לשליחה)"
                        className="min-h-16 pb-14"
                      />
                      <button
                        type="button"
                        onClick={() => void addComment()}
                        disabled={!commentInput.trim()}
                        aria-label="שלח תגובה"
                        className={cn(
                          'absolute bottom-2 end-2 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition-colors',
                          commentInput.trim()
                            ? 'bg-blue-600 text-white hover:bg-blue-700'
                            : 'bg-slate-200 text-slate-400 cursor-not-allowed',
                        )}
                      >
                        <Send className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </Section>
              )}
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאה — כניסה כצופה' : undefined}
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור תקלה'}
            onDelete={isEdit && canEdit && onDelete ? onDelete : undefined}
            deleteLabel="מחק תקלה"
          />
        </SheetContent>
      </Sheet>

      <ImageLightbox open={!!lightbox} src={lightbox} onClose={() => setLightbox(null)} />

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שביצעת לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardClose} className="bg-destructive text-white hover:bg-destructive/90">
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
