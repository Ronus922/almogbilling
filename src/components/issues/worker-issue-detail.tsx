'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRight, ChevronRight, ChevronLeft, MapPin, Play, Check, Camera,
  Send, MessageSquare, Images, Video, Loader2,
} from 'lucide-react';
import { ImageLightbox } from './ImageLightbox';
import { cn } from '@/lib/utils';
import {
  ISSUE_STATUS_BADGE, ISSUE_PRIORITY_BADGE,
  issueStatusLabel, issuePriorityLabel,
  ISSUE_ALLOWED_IMAGE_TYPES, ISSUE_MAX_IMAGE_SIZE_BYTES, ISSUE_MAX_IMAGES,
} from '@/lib/constants/issues';
import type { IssueComment, IssueImage, IssueStatus, IssueWithMeta } from '@/lib/types/issues';

interface Props {
  issue: IssueWithMeta;
  onBack: () => void;
  /** Bubbles a status change back to the list so the card reflects it. */
  onStatusChange: (id: string, status: IssueStatus) => void;
}

interface MediaItem {
  kind: 'image' | 'video';
  path: string;
  src: string | null;
}

/**
 * Field-worker issue detail (M1–M5). Reached by tapping a card in
 * WorkerIssuesView. Read-only on everything a worker doesn't own: it shows the
 * full description, location and badges (M1), a media carousel (M2), and the
 * three moves a worker actually has — mark done (M3), comment (M4), attach a
 * "done" photo (M5). No manager surface (assignment / suppliers / notify).
 *
 * Access is enforced server-side: GET/PATCH/comments/images all run through the
 * issueAccess-guarded routes, so an unassigned worker gets a 404 here even if
 * they somehow reach a foreign id.
 */
export function WorkerIssueDetail({ issue, onBack, onStatusChange }: Props) {
  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/issues/${issue.id}`, { credentials: 'include' });
      if (r.status === 404 || r.status === 403) {
        toast.error('התקלה אינה זמינה');
        onBack();
        return;
      }
      if (!r.ok) return;
      const data = (await r.json()) as {
        comments?: IssueComment[];
        images?: IssueImage[];
        videos?: IssueImage[];
      };
      const imgs: MediaItem[] = (data.images ?? []).map((m) => ({ kind: 'image', path: m.path, src: m.signed_url }));
      const vids: MediaItem[] = (data.videos ?? []).map((m) => ({ kind: 'video', path: m.path, src: m.signed_url }));
      setMedia([...imgs, ...vids]);
      setComments(Array.isArray(data.comments) ? data.comments : []);
      setIdx(0);
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, [issue.id, onBack]);

  useEffect(() => { void load(); }, [load]);

  const inProgress = status === 'in_progress';

  // Same two moves as the card: start → in_progress, complete → closed (closed,
  // not resolved — resolving needs notes this screen has no field for).
  async function changeStatus(next: IssueStatus, okMessage: string) {
    const prev = status;
    setBusy(true);
    setStatus(next);
    try {
      const r = await fetch(`/api/issues/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error('עדכון התקלה נכשל');
      onStatusChange(issue.id, next);
      toast.success(okMessage);
    } catch (e) {
      setStatus(prev);
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addComment() {
    const content = commentInput.trim();
    if (!content) return;
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

  // M5: attach a "done" photo — lands in the issue's image gallery (same route
  // the manager form uses), so it shows up in this carousel too.
  async function attachPhoto(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const imageCount = media.filter((m) => m.kind === 'image').length;
    if (imageCount >= ISSUE_MAX_IMAGES) {
      toast.error(`ניתן לצרף עד ${ISSUE_MAX_IMAGES} תמונות`);
      return;
    }
    const file = list[0];
    if (!ISSUE_ALLOWED_IMAGE_TYPES.includes(file.type)) {
      toast.error('סוג קובץ לא נתמך (JPG / PNG / WebP בלבד)');
      return;
    }
    if (file.size > ISSUE_MAX_IMAGE_SIZE_BYTES) {
      toast.error('הקובץ גדול מדי (עד 5MB)');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/issues/${issue.id}/images`, { method: 'POST', credentials: 'include', body: fd });
      const data = (await r.json().catch(() => ({}))) as { image?: IssueImage };
      if (!r.ok || !data.image) throw new Error('העלאת התמונה נכשלה');
      setMedia((prev) => {
        const next: MediaItem[] = [...prev, { kind: 'image', path: data.image!.path, src: data.image!.signed_url }];
        setIdx(next.length - 1); // jump to the freshly-added photo
        return next;
      });
      toast.success('התמונה צורפה');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (cameraRef.current) cameraRef.current.value = '';
    }
  }

  const current = media[idx] ?? null;
  const hasMedia = media.length > 0;
  const go = (delta: number) => setIdx((i) => (media.length ? (i + delta + media.length) % media.length : 0));

  const statusBadge = useMemo(() => ISSUE_STATUS_BADGE[status], [status]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Back + header banner */}
      <div className="rounded-2xl bg-blue-800 p-6 text-white">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-3 text-sm font-semibold text-white transition-colors hover:bg-white/25"
        >
          <ArrowRight className="h-4 w-4" />
          חזרה
        </button>
        <h1 className="text-2xl font-extrabold leading-tight">{issue.title}</h1>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className={cn('rounded-full px-3 py-1 text-[12.5px] font-bold', statusBadge)}>
            {issueStatusLabel(status)}
          </span>
          <span className={cn('rounded-full px-3 py-1 text-[12.5px] font-bold', ISSUE_PRIORITY_BADGE[issue.priority])}>
            {issuePriorityLabel(issue.priority)}
          </span>
        </div>
      </div>

      {/* M1: location + description */}
      <div className="space-y-4 rounded-[22px] border border-slate-200 bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
        {issue.target_label && (
          <p className="flex items-center gap-1.5 text-[15px] font-semibold text-slate-700">
            <MapPin className="h-4 w-4 shrink-0 text-slate-400" />
            {issue.target_label}
          </p>
        )}
        <div>
          <h2 className="text-sm font-bold text-slate-500">תיאור התקלה</h2>
          <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">
            {issue.description?.trim() || 'לא נמסר תיאור.'}
          </p>
        </div>
      </div>

      {/* M2: media carousel */}
      <div className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-500">
          <Images className="h-4 w-4" />
          מדיה
        </h2>
        {loading ? (
          <div className="grid h-56 place-items-center text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : !hasMedia ? (
          <p className="py-8 text-center text-sm text-slate-400">אין תמונות או סרטונים לתקלה זו.</p>
        ) : (
          <div className="relative">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
              {current?.kind === 'image' ? (
                current.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={current.src}
                    alt="מדיה של התקלה"
                    onClick={() => current.src && setLightbox(current.src)}
                    className="h-full w-full cursor-zoom-in object-contain"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-slate-500"><Images className="h-8 w-8" /></div>
                )
              ) : current?.src ? (
                <video src={current.src} controls preload="metadata" className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full w-full place-items-center text-slate-500"><Video className="h-8 w-8" /></div>
              )}

              {media.length > 1 && (
                <>
                  {/* RTL: previous sits on the right, next on the left. */}
                  <button
                    type="button"
                    onClick={() => go(-1)}
                    aria-label="הקודם"
                    className="absolute end-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-slate-900/60 text-white transition-colors hover:bg-slate-900/80"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => go(1)}
                    aria-label="הבא"
                    className="absolute start-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-slate-900/60 text-white transition-colors hover:bg-slate-900/80"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                </>
              )}

              <span className="absolute bottom-2 start-1/2 -translate-x-1/2 rounded-full bg-slate-900/70 px-2.5 py-0.5 text-xs font-semibold text-white tabular-nums">
                {idx + 1} / {media.length}
              </span>
            </div>

            {/* Dots */}
            {media.length > 1 && (
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {media.map((m, i) => (
                  <button
                    key={m.path}
                    type="button"
                    onClick={() => setIdx(i)}
                    aria-label={`מדיה ${i + 1}`}
                    className={cn(
                      'h-2 rounded-full transition-all',
                      i === idx ? 'w-5 bg-blue-600' : 'w-2 bg-slate-300 hover:bg-slate-400',
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* M3 + M5: complete + attach a done photo */}
      <div className="space-y-3 rounded-[22px] border border-slate-200 bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
        <input
          ref={cameraRef}
          type="file"
          accept={ISSUE_ALLOWED_IMAGE_TYPES.join(',')}
          capture="environment"
          className="hidden"
          onChange={(e) => void attachPhoto(e.target.files)}
        />
        <button
          type="button"
          onClick={() => cameraRef.current?.click()}
          disabled={uploading}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-slate-100 px-4 text-base font-bold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-60"
        >
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
          {uploading ? 'מעלה…' : 'צרף תמונת ביצוע'}
        </button>

        {inProgress ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void changeStatus('closed', 'התקלה הושלמה')}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            <Check className="h-5 w-5" />
            {busy ? 'מעדכן…' : 'סמן כבוצע'}
          </button>
        ) : status === 'open' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void changeStatus('in_progress', 'התקלה בטיפול')}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-4 text-base font-extrabold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            <Play className="h-5 w-5" />
            {busy ? 'מעדכן…' : 'התחל טיפול'}
          </button>
        ) : null}
      </div>

      {/* M4: comments */}
      <div className="space-y-3 rounded-[22px] border border-slate-200 bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-500">
          <MessageSquare className="h-4 w-4" />
          תגובות
        </h2>
        {comments.length === 0 && (
          <p className="py-2 text-center text-xs text-slate-400">אין תגובות עדיין.</p>
        )}
        {comments.map((c) => (
          <div key={c.id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
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
          <textarea
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            placeholder="הוסף תגובה…"
            className="min-h-16 w-full resize-y rounded-lg border border-slate-200 bg-white p-3 pb-14 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <button
            type="button"
            onClick={() => void addComment()}
            disabled={!commentInput.trim()}
            aria-label="שלח תגובה"
            className={cn(
              'absolute bottom-2 end-2 inline-flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition-colors',
              commentInput.trim()
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'cursor-not-allowed bg-slate-200 text-slate-400',
            )}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ImageLightbox open={!!lightbox} src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}
