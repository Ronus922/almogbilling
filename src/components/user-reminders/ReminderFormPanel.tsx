'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { X, Bell, CalendarClock, Plus, Tag, User } from 'lucide-react';
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
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { REMINDER_STATUSES, reminderStatusLabel } from '@/lib/constants/userReminders';
import { REMINDER_DESCRIPTION_MAX } from '@/lib/validation/userReminders';
import { isUploading, readyAttachmentIds, type StagedAttachment } from '@/lib/hooks/useStagedUploads';
import type {
  UserReminderAttachmentView, UserReminderDetail, UserReminderStatus, UserReminderWithNames,
} from '@/lib/types/userReminders';
import type { ReminderCategoryWithCount } from '@/lib/types/reminderCategories';
import { reminderErrorMessage } from './helpers';
import { ReminderAttachments } from './ReminderAttachments';

interface Assignee {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  /** null → create mode; a reminder → edit mode. */
  reminder: UserReminderWithNames | null;
  canEdit: boolean;
  assignees: Assignee[];
  categories: ReminderCategoryWithCount[];
  /** Pre-selected category for a fresh create (the active category filter). */
  defaultCategoryId?: string | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  status: UserReminderStatus;
  category_id: string; // '' = none
  assigned_to: string; // '' = none
}

const NONE = '__none__';

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitRemindAt(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: todayStr(), time: '09:00' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function ReminderFormPanel({
  open, reminder, canEdit, assignees, categories, defaultCategoryId = null,
  onOpenChange, onSaved,
}: Props) {
  const isEdit = !!reminder;

  function buildInitial(): FormState {
    if (reminder) {
      const { date, time } = splitRemindAt(reminder.remind_at);
      return {
        title: reminder.title,
        description: reminder.description ?? '',
        date,
        time,
        status: reminder.status,
        category_id: reminder.category_id ?? '',
        assigned_to: reminder.assigned_to ?? '',
      };
    }
    return {
      title: '',
      description: '',
      date: todayStr(),
      time: '09:00',
      status: 'pending',
      category_id: defaultCategoryId ?? '',
      assigned_to: '',
    };
  }

  const [form, setForm] = useState<FormState>(buildInitial);
  const [initial, setInitial] = useState<FormState>(buildInitial);
  const [titleTouched, setTitleTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  // Files: the saved ones (edit mode, fetched on open) and this session's
  // uploads, which are linked to the reminder on save.
  const [existingFiles, setExistingFiles] = useState<UserReminderAttachmentView[]>([]);
  /** The reminder whose saved files have been fetched (null = not yet). */
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [fileToRemove, setFileToRemove] = useState<UserReminderAttachmentView | null>(null);

  useEffect(() => {
    if (open) {
      const init = buildInitial();
      setForm(init);
      setInitial(init);
      setTitleTouched(false);
      setSubmitting(false);
      setStaged([]);
      setExistingFiles([]);
      setFilesFor(null);
      setFileToRemove(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reminder, defaultCategoryId]);

  // Edit mode: the reminder's saved files come from GET /api/user-reminders/[id].
  const reminderId = reminder?.id ?? null;
  const filesLoading = open && !!reminderId && filesFor !== reminderId;
  useEffect(() => {
    if (!open || !reminderId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/user-reminders/${reminderId}`, { credentials: 'include' });
        const data = (await res.json().catch(() => ({}))) as { reminder?: UserReminderDetail; error?: string };
        if (!res.ok || !data.reminder) throw new Error(reminderErrorMessage(data.error));
        if (!cancelled) setExistingFiles(data.reminder.attachments ?? []);
      } catch {
        if (!cancelled) toast.error('טעינת הקבצים המצורפים נכשלה');
      } finally {
        if (!cancelled) setFilesFor(reminderId);
      }
    })();
    return () => { cancelled = true; };
  }, [open, reminderId]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const titleError = titleTouched && !form.title.trim() ? 'כותרת היא שדה חובה' : null;
  const uploading = isUploading(staged);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initial) || staged.length > 0,
    [form, initial, staged.length],
  );
  const canSubmit = canEdit && !!form.title.trim() && !!form.date && !submitting && !uploading;

  useEscapeKey(open && !confirmCloseOpen && !fileToRemove, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting || uploading) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }
  function discardStaged() {
    // Best-effort: uploads that were never saved are removed now rather than
    // waiting for the Storage GC's 24h window.
    for (const s of staged) {
      if (s.attachmentId) {
        void fetch(`/api/user-reminders/attachments/${s.attachmentId}`, {
          method: 'DELETE', credentials: 'include', keepalive: true,
        }).catch(() => undefined);
      }
    }
  }
  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    discardStaged();
    onOpenChange(false);
  }

  async function removeExistingFile(file: UserReminderAttachmentView) {
    setFileToRemove(null);
    try {
      const res = await fetch(`/api/user-reminders/attachments/${file.id}`, { method: 'DELETE', credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'מחיקת הקובץ נכשלה');
      setExistingFiles((list) => list.filter((f) => f.id !== file.id));
      toast.success('הקובץ נמחק');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTitleTouched(true);
      return;
    }
    const local = new Date(`${form.date}T${(form.time || '09:00')}:00`);
    if (Number.isNaN(local.getTime())) {
      toast.error('תאריך לא תקין');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim(),
        attachment_ids: readyAttachmentIds(staged),
        remind_at: local.toISOString(),
        status: form.status,
        category_id: form.category_id || null,
        assigned_to: form.assigned_to || null,
      };
      const url = isEdit ? `/api/user-reminders/${reminder!.id}` : '/api/user-reminders';
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; attachments_linked?: number; attachments_requested?: number;
      };
      if (!res.ok) throw new Error(reminderErrorMessage(data.error));
      if ((data.attachments_linked ?? 0) < (data.attachments_requested ?? 0)) {
        toast.warning('חלק מהקבצים לא צורפו — פתח את התזכורת וצרף אותם שוב');
      }

      toast.success(isEdit ? 'התזכורת עודכנה' : 'התזכורת נוצרה');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
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
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? 'עריכת תזכורת' : 'תזכורת חדשה'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'כותרת, תיאור, קבצים, מועד, סטטוס, קטגוריה ושיוך.'
                    : 'תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              {/* Details */}
              <Section title="פרטי התזכורת" icon={Bell} iconTone="amber">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="rem-title" className="text-base font-medium text-muted-foreground">
                      כותרת<span className="text-red-500"> *</span>
                    </Label>
                    <Input
                      id="rem-title"
                      value={form.title}
                      onChange={(e) => set('title', e.target.value)}
                      onBlur={() => setTitleTouched(true)}
                      disabled={disabled}
                      autoFocus={!isEdit}
                      placeholder="למשל: לחזור לדייר בנושא חוב"
                      className={cn('h-10', titleError && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                    />
                    {titleError && (
                      <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {titleError}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <Label htmlFor="rem-description" className="text-base font-medium text-muted-foreground">תיאור</Label>
                      <span className="text-xs text-muted-foreground">רשות</span>
                    </div>
                    <Textarea
                      id="rem-description"
                      value={form.description}
                      onChange={(e) => set('description', e.target.value)}
                      disabled={disabled}
                      maxLength={REMINDER_DESCRIPTION_MAX}
                      placeholder="פרטים נוספים, הקשר, מה צריך לעשות…"
                      className="min-h-[110px] rounded-[10px] px-3.5 py-2.5 leading-relaxed focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-[rgba(61,90,254,0.12)]"
                    />
                    <div className="flex justify-between gap-2.5 text-xs text-slate-400">
                      <span>{form.description.trim() ? 'יוצג גם למשתמש המשויך' : ''}</span>
                      <span className="font-num tabular-nums" dir="ltr">
                        {form.description.length} / {REMINDER_DESCRIPTION_MAX}
                      </span>
                    </div>
                  </div>

                  <ReminderAttachments
                    existing={filesFor === reminderId ? existingFiles : []}
                    loading={filesLoading}
                    staged={staged}
                    onStagedChange={setStaged}
                    canEdit={canEdit}
                    disabled={disabled || filesLoading}
                    onRemoveExisting={setFileToRemove}
                  />

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="rem-date" className="text-base font-medium text-muted-foreground">
                        תאריך<span className="text-red-500"> *</span>
                      </Label>
                      <Input
                        id="rem-date"
                        type="date"
                        value={form.date}
                        onChange={(e) => set('date', e.target.value)}
                        disabled={disabled}
                        onClick={(e) => {
                          const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                          try { el.showPicker?.(); } catch { /* native fallback */ }
                        }}
                        className="h-10 cursor-pointer"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="rem-time" className="text-base font-medium text-muted-foreground">שעה</Label>
                      <Input
                        id="rem-time"
                        type="time"
                        value={form.time}
                        onChange={(e) => set('time', e.target.value)}
                        disabled={disabled}
                        dir="ltr"
                        className="h-10 cursor-pointer tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">סטטוס</Label>
                    <Select value={form.status} onValueChange={(v) => { if (v) set('status', v as UserReminderStatus); }} disabled={disabled}>
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue>{(v: string | null) => (v ? reminderStatusLabel(v as UserReminderStatus) : null)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {REMINDER_STATUSES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </Section>

              {/* Category + assignment */}
              <Section title="קטגוריה ושיוך" icon={Tag} iconTone="violet">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">קטגוריה</Label>
                    <Select
                      value={form.category_id || NONE}
                      onValueChange={(v) => { if (v) set('category_id', v === NONE ? '' : v); }}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue>
                          {(v: string | null) => {
                            if (!v || v === NONE) return 'ללא קטגוריה';
                            const c = categories.find((x) => x.id === v);
                            if (!c) return 'קטגוריה';
                            return (
                              <span className="inline-flex items-center gap-2">
                                <span className="h-3 w-3 rounded-full ring-1 ring-slate-200" style={{ backgroundColor: c.color }} />
                                {c.name}
                              </span>
                            );
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>ללא קטגוריה</SelectItem>
                        {categories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            <span className="inline-flex items-center gap-2">
                              <span className="h-3 w-3 rounded-full ring-1 ring-slate-200" style={{ backgroundColor: c.color }} />
                              {c.name}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-base font-medium text-muted-foreground">
                      <User className="h-4 w-4" /> משויך אל
                    </Label>
                    <Select
                      value={form.assigned_to || NONE}
                      onValueChange={(v) => { if (v) set('assigned_to', v === NONE ? '' : v); }}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue>
                          {(v: string | null) => {
                            if (!v || v === NONE) return 'ללא שיוך (אישית)';
                            return assignees.find((a) => a.id === v)?.name ?? 'משתמש';
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>ללא שיוך (אישית)</SelectItem>
                        {assignees.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="flex items-center gap-1 text-[12px] text-slate-400">
                      <CalendarClock className="h-3 w-3" />
                      שיוך למשתמש אחר ישתף איתו את התזכורת, כולל התיאור והקבצים.
                    </p>
                  </div>
                </div>
              </Section>
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאה — כניסה כצופה' : undefined}
            saveLabel={submitting ? 'שומר…' : uploading ? 'מעלה קבצים…' : isEdit ? 'שמור שינויים' : 'יצירת תזכורת'}
            saveIcon={isEdit ? undefined : Plus}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              השינויים שביצעת לא יישמרו{staged.length > 0 ? ' והקבצים שהועלו יוסרו' : ''}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardClose} className="bg-destructive text-white hover:bg-destructive/90">
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={fileToRemove !== null} onOpenChange={(o) => { if (!o) setFileToRemove(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הקובץ?</AlertDialogTitle>
            <AlertDialogDescription>
              {fileToRemove ? `«${fileToRemove.original_name}» יימחק מהתזכורת ומהאחסון.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (fileToRemove) void removeExistingFile(fileToRemove); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
