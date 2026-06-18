'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  X, AlertTriangle, MapPin, User, Images, MessageSquare, Trash2, Send,
  ListTodo, Link2, CheckCircle2, Upload, Loader2, Wrench, Phone,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { ImageLightbox } from './ImageLightbox';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { formatPhoneDisplay, phoneTelHref } from '@/lib/phone';
import {
  ISSUE_STATUSES, ISSUE_PRIORITIES,
  issueStatusLabel, issuePriorityLabel,
  ISSUE_ALLOWED_IMAGE_TYPES, ISSUE_MAX_IMAGE_SIZE_BYTES, ISSUE_MAX_IMAGES,
} from '@/lib/constants/issues';
import type {
  Issue, IssueComment, IssueImage, IssuePriority, IssueStatus, IssueSupplierOption,
} from '@/lib/types/issues';
import type { TargetType } from '@/lib/types/targets';
import { TargetField } from '@/components/targets/TargetField';
import {
  RemindersSection, splitRemindAt, buildRemindersPayload, type ReminderRow,
} from '@/components/reminders/RemindersSection';

interface Assignee {
  id: string;
  name: string;
}

/** The handler is EITHER an internal user OR an external supplier — never both. */
type AssigneeType = 'none' | 'user' | 'supplier';

interface Props {
  open: boolean;
  /** null → create mode; an issue → edit mode. */
  issue: Issue | null;
  canEdit: boolean;
  assignees: Assignee[];
  suppliers: IssueSupplierOption[];
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  title: string;
  description: string;
  priority: IssuePriority;
  status: IssueStatus;
  /** Mutually-exclusive handler model. */
  assignee_type: AssigneeType;
  assigned_to_user_id: string; // '' = none
  supplier_id: string;         // '' = none
  resolution_notes: string;
  target_type: TargetType | null;
  target_id: string | null;
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  priority: 'normal',
  status: 'open',
  assignee_type: 'none',
  assigned_to_user_id: '',
  supplier_id: '',
  resolution_notes: '',
  target_type: null,
  target_id: null,
};

function fromIssue(i: Issue): FormState {
  // Derive the handler type from whichever field is populated (no extra column).
  const assignee_type: AssigneeType =
    i.supplier_id ? 'supplier' : i.assigned_to_user_id ? 'user' : 'none';
  return {
    title: i.title,
    description: i.description ?? '',
    priority: i.priority,
    status: i.status,
    assignee_type,
    assigned_to_user_id: i.assigned_to_user_id ?? '',
    supplier_id: i.supplier_id ?? '',
    resolution_notes: i.resolution_notes ?? '',
    target_type: i.target_type,
    target_id: i.target_id,
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  title_required: 'כותרת היא שדה חובה',
  resolution_notes_required: 'יש להזין הערות טיפול לפני סימון התקלה כ"טופלה"',
  invalid_file_type: 'סוג קובץ לא נתמך (JPG / PNG / WebP בלבד)',
  file_too_large: 'הקובץ גדול מדי (עד 5MB)',
  too_many_images: `ניתן לצרף עד ${ISSUE_MAX_IMAGES} תמונות`,
  task_already_linked: 'כבר קיימת משימה מקושרת לתקלה זו',
};

function mapError(code: string | undefined, fallback: string): string {
  return (code && ERROR_MESSAGES[code]) || fallback;
}

export function IssueFormPanel({ open, issue, canEdit, assignees, suppliers, onOpenChange, onSaved }: Props) {
  const isEdit = !!issue;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  // Display name for a linked supplier that may be soft-deleted (and thus absent
  // from the active `suppliers` picker list) — keeps the trigger label correct.
  const [supplierFallback, setSupplierFallback] = useState<string | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [images, setImages] = useState<IssueImage[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [initialReminders, setInitialReminders] = useState<ReminderRow[]>([]);
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(null);
  const [commentInput, setCommentInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/issues/${id}`, { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as {
        issue?: Issue & { linked_task_id?: string | null; supplier_display_name?: string | null };
        comments?: IssueComment[];
        images?: IssueImage[];
        reminders?: { id: string; remind_at: string; channel: ReminderRow['channel'] }[];
      };
      setSupplierFallback(data.issue?.supplier_display_name ?? null);
      setComments(Array.isArray(data.comments) ? data.comments : []);
      setImages(Array.isArray(data.images) ? data.images : []);
      const rem = (data.reminders ?? []).map((x) => {
        const { date, time } = splitRemindAt(x.remind_at);
        return { date, time, channel: x.channel };
      });
      setReminders(rem);
      setInitialReminders(rem);
      // linked task id comes back on the enriched issue row
      const lt = (data.issue as { linked_task_id?: string | null } | undefined)?.linked_task_id;
      setLinkedTaskId(lt ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (open) {
      const init = issue ? fromIssue(issue) : EMPTY_FORM;
      setForm(init);
      setInitial(init);
      setSupplierFallback(null);
      setComments([]);
      setImages([]);
      setReminders([]);
      setInitialReminders([]);
      setLinkedTaskId(null);
      setCommentInput('');
      setTitleTouched(false);
      setSubmitting(false);
      setUploading(false);
      setCreatingTask(false);
      if (issue) void loadDetail(issue.id);
    }
  }, [open, issue, loadDetail]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Switching the handler type clears the other side's selection (mutual model).
  function setAssigneeType(t: AssigneeType) {
    setForm((prev) => ({
      ...prev,
      assignee_type: t,
      assigned_to_user_id: t === 'user' ? prev.assigned_to_user_id : '',
      supplier_id: t === 'supplier' ? prev.supplier_id : '',
    }));
  }

  const selectedSupplierPhone =
    suppliers.find((s) => s.id === form.supplier_id)?.phone ?? null;

  const titleError = titleTouched && !form.title.trim() ? 'כותרת היא שדה חובה' : null;
  const resolutionMissing =
    form.status === 'resolved' && !form.resolution_notes.trim();

  const dirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(initial) ||
      JSON.stringify(reminders) !== JSON.stringify(initialReminders),
    [form, initial, reminders, initialReminders],
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
    const remindersPayload = buildRemindersPayload(reminders);
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
        // Mutually-exclusive handler: send exactly one side (the other null).
        assigned_to_user_id: form.assignee_type === 'user' ? (form.assigned_to_user_id || null) : null,
        supplier_id: form.assignee_type === 'supplier' ? (form.supplier_id || null) : null,
        resolution_notes: form.resolution_notes.trim() || null,
        // Target is optional. A type without a value persists as no target.
        target_type: form.target_id ? form.target_type : null,
        target_id: form.target_id || null,
      };
      // Only send reminders array if it changed (replacement semantics — same as tasks).
      const remindersChanged =
        JSON.stringify(reminders) !== JSON.stringify(initialReminders);
      if (remindersChanged) body.reminders = remindersPayload;

      const url = isEdit ? `/api/issues/${issue!.id}` : '/api/issues';
      const method = isEdit ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        throw new Error(mapError(data.error, isEdit ? 'עדכון התקלה נכשל' : 'יצירת התקלה נכשלה'));
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

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !issue) return;
    if (images.length >= ISSUE_MAX_IMAGES) {
      toast.error(`ניתן לצרף עד ${ISSUE_MAX_IMAGES} תמונות`);
      return;
    }
    const file = files[0];
    // Client-side guard (server re-validates).
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
      const r = await fetch(`/api/issues/${issue.id}/images`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = (await r.json().catch(() => ({}))) as { image?: IssueImage; error?: string };
      if (!r.ok || !data.image) throw new Error(mapError(data.error, 'העלאת התמונה נכשלה'));
      setImages((prev) => [...prev, data.image!]);
      toast.success('התמונה הועלתה');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function removeImage(path: string) {
    if (!issue) return;
    const prev = images;
    setImages((curr) => curr.filter((img) => img.path !== path)); // optimistic
    try {
      const r = await fetch(`/api/issues/${issue.id}/images`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error('מחיקת התמונה נכשלה');
      toast.success('התמונה הוסרה');
    } catch (e) {
      setImages(prev);
      toast.error((e as Error).message);
    }
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

  async function createTaskFromIssue() {
    if (!issue) return;
    setCreatingTask(true);
    try {
      const r = await fetch(`/api/issues/${issue.id}/create-task`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = (await r.json().catch(() => ({}))) as { task?: { id: string }; error?: string };
      if (!r.ok || !data.task) throw new Error(mapError(data.error, 'יצירת המשימה נכשלה'));
      setLinkedTaskId(data.task.id);
      toast.success('נוצרה משימה מקושרת');
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreatingTask(false);
    }
  }

  const disabled = submitting || !canEdit;

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
              <Section title="מיקום" icon={MapPin} iconTone="amber">
                <div className="py-2">
                  <TargetField
                    value={{ type: form.target_type, id: form.target_id }}
                    onChange={(t) => setForm((prev) => ({ ...prev, target_type: t.type, target_id: t.id }))}
                    disabled={disabled}
                  />
                </div>
              </Section>

              {/* Handler — internal user OR external supplier (mutually exclusive) */}
              <Section title="גורם מטפל" icon={User} iconTone="violet">
                <div className="space-y-3 py-2">
                  {/* Type selector */}
                  <div className="inline-flex w-full gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    <AssigneeTypeButton
                      active={form.assignee_type === 'none'}
                      onClick={() => setAssigneeType('none')}
                      disabled={disabled}
                    >
                      ללא שיוך
                    </AssigneeTypeButton>
                    <AssigneeTypeButton
                      active={form.assignee_type === 'user'}
                      onClick={() => setAssigneeType('user')}
                      disabled={disabled}
                      icon={User}
                    >
                      עובד פנימי
                    </AssigneeTypeButton>
                    <AssigneeTypeButton
                      active={form.assignee_type === 'supplier'}
                      onClick={() => setAssigneeType('supplier')}
                      disabled={disabled}
                      icon={Wrench}
                    >
                      ספק חיצוני
                    </AssigneeTypeButton>
                  </div>

                  {/* Matching searchable picker */}
                  {form.assignee_type === 'user' && (
                    <Combobox
                      value={form.assigned_to_user_id || null}
                      onChange={(v) => set('assigned_to_user_id', v ?? '')}
                      options={assignees.map((a) => ({ value: a.id, label: a.name }))}
                      placeholder="בחר עובד…"
                      searchPlaceholder="חיפוש עובד…"
                      emptyText="לא נמצאו עובדים"
                      disabled={disabled}
                    />
                  )}

                  {form.assignee_type === 'supplier' && (
                    <div className="space-y-2">
                      <Combobox
                        value={form.supplier_id || null}
                        onChange={(v) => set('supplier_id', v ?? '')}
                        options={suppliers.map((s) => ({
                          value: s.id,
                          label: s.display_name,
                          keywords: s.phone,
                        }))}
                        placeholder="בחר ספק…"
                        searchPlaceholder="חיפוש ספק…"
                        emptyText="לא נמצאו ספקים"
                        fallbackLabel={supplierFallback ?? undefined}
                        disabled={disabled}
                      />
                      {selectedSupplierPhone && phoneTelHref(selectedSupplierPhone) && (
                        <a
                          href={`tel:${phoneTelHref(selectedSupplierPhone)}`}
                          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
                          dir="ltr"
                        >
                          <Phone className="h-3.5 w-3.5" />
                          <span className="tabular-nums">{formatPhoneDisplay(selectedSupplierPhone)}</span>
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </Section>

              {/* Reminders (shared component — also used by the task form). Optional. */}
              <RemindersSection reminders={reminders} onChange={setReminders} disabled={disabled} />

              {/* Images — edit mode only (need an issue id to attach to) */}
              {isEdit && (
                <Section
                  title="תמונות"
                  icon={Images}
                  iconTone="blue"
                  subtitle={`${images.length}/${ISSUE_MAX_IMAGES} · JPG / PNG / WebP · עד 5MB`}
                  headerSlot={
                    canEdit && images.length < ISSUE_MAX_IMAGES ? (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-60"
                      >
                        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {uploading ? 'מעלה…' : 'העלאה'}
                      </button>
                    ) : undefined
                  }
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ISSUE_ALLOWED_IMAGE_TYPES.join(',')}
                    className="hidden"
                    onChange={(e) => void handleUpload(e.target.files)}
                  />
                  <div className="py-2">
                    {images.length === 0 ? (
                      <p className="py-2 text-center text-xs text-slate-400">אין תמונות. העלה תמונה כדי לתעד את התקלה.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {images.map((img) => (
                          <div key={img.path} className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                            {img.signed_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={img.signed_url}
                                alt="תמונת תקלה"
                                onClick={() => setLightbox(img.signed_url)}
                                className="h-full w-full cursor-zoom-in object-cover transition-transform group-hover:scale-105"
                              />
                            ) : (
                              <div className="grid h-full w-full place-items-center text-slate-400">
                                <Images className="h-5 w-5" />
                              </div>
                            )}
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => void removeImage(img.path)}
                                aria-label="מחק תמונה"
                                className="absolute top-1 end-1 grid h-7 w-7 place-items-center rounded-md bg-slate-900/60 text-white opacity-0 transition-opacity hover:bg-rose-600 group-hover:opacity-100"
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
              )}

              {/* Linked task / create-task — edit mode only */}
              {isEdit && (
                <Section title="משימה מקושרת" icon={ListTodo} iconTone="emerald">
                  <div className="py-2">
                    {linkedTaskId ? (
                      <a
                        href={`/tasks?task=${linkedTaskId}`}
                        className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                      >
                        <Link2 className="h-4 w-4" />
                        פתח את המשימה המקושרת
                      </a>
                    ) : canEdit ? (
                      <button
                        type="button"
                        onClick={() => void createTaskFromIssue()}
                        disabled={creatingTask}
                        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                      >
                        {creatingTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        {creatingTask ? 'יוצר משימה…' : 'צור משימה מתקלה'}
                      </button>
                    ) : (
                      <p className="py-2 text-center text-xs text-slate-400">אין משימה מקושרת.</p>
                    )}
                  </div>
                </Section>
              )}

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

/** One segment of the handler-type selector (ללא / עובד / ספק). */
function AssigneeTypeButton({
  active, onClick, disabled, icon: Icon, children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon?: typeof User;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        active
          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
          : 'text-slate-500 hover:text-slate-700',
      )}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </button>
  );
}
