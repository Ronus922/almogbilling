'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  X, ClipboardList, User, Bell, MessageSquare, Plus, Trash2, Send,
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
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import {
  TASK_STATUSES, TASK_PRIORITIES, taskStatusLabel, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type {
  ReminderChannel, Task, TaskComment, TaskPriority, TaskStatus,
} from '@/lib/types/tasks';
import type { TargetType } from '@/lib/types/targets';
import { TargetField } from '@/components/targets/TargetField';

interface Assignee {
  id: string;
  name: string;
}

interface ReminderRow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channel: ReminderChannel;
}

interface ServerReminder {
  id: string;
  remind_at: string;
  channel: ReminderChannel;
}

interface Props {
  open: boolean;
  /** null → create mode; a task → edit mode. */
  task: Task | null;
  canEdit: boolean;
  assignees: Assignee[];
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string;
  due_time: string;
  assigned_to_user_id: string; // '' = none
  apartment_number: string;
  target_type: TargetType | null;
  target_id: string | null;
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  status: 'open',
  priority: 'normal',
  due_date: '',
  due_time: '',
  assigned_to_user_id: '',
  apartment_number: '',
  target_type: null,
  target_id: null,
};

const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  in_app: 'בתוך המערכת',
  email: 'אימייל',
  both: 'שניהם',
};

function fromTask(t: Task): FormState {
  return {
    title: t.title,
    description: t.description ?? '',
    status: t.status,
    priority: t.priority,
    due_date: t.due_date ?? '',
    due_time: t.due_time ? t.due_time.slice(0, 5) : '',
    assigned_to_user_id: t.assigned_to_user_id ?? '',
    apartment_number: t.apartment_number ?? '',
    target_type: t.target_type,
    target_id: t.target_id,
  };
}

function splitRemindAt(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function TaskFormPanel({ open, task, canEdit, assignees, onOpenChange, onSaved }: Props) {
  const isEdit = !!task;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [initialReminders, setInitialReminders] = useState<ReminderRow[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/tasks/${id}`, { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as {
        comments?: TaskComment[];
        reminders?: ServerReminder[];
      };
      setComments(Array.isArray(data.comments) ? data.comments : []);
      const rem = (data.reminders ?? []).map((x) => {
        const { date, time } = splitRemindAt(x.remind_at);
        return { date, time, channel: x.channel };
      });
      setReminders(rem);
      setInitialReminders(rem);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (open) {
      const init = task ? fromTask(task) : EMPTY_FORM;
      setForm(init);
      setInitial(init);
      setComments([]);
      setCommentInput('');
      setReminders([]);
      setInitialReminders([]);
      setTitleTouched(false);
      setSubmitting(false);
      if (task) void loadDetail(task.id);
    }
  }, [open, task, loadDetail]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const titleError = titleTouched && !form.title.trim() ? 'כותרת היא שדה חובה' : null;

  const dirty = useMemo(
    () =>
      JSON.stringify(form) !== JSON.stringify(initial) ||
      JSON.stringify(reminders) !== JSON.stringify(initialReminders),
    [form, initial, reminders, initialReminders],
  );
  const canSubmit = canEdit && !!form.title.trim() && !submitting;

  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }
  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  function addReminder() {
    setReminders((prev) => [...prev, { date: '', time: '09:00', channel: 'both' }]);
  }
  function updateReminder(idx: number, patch: Partial<ReminderRow>) {
    setReminders((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeReminder(idx: number) {
    setReminders((prev) => prev.filter((_, i) => i !== idx));
  }

  function buildRemindersPayload(): { remind_at: string; channel: ReminderChannel }[] | null {
    const out: { remind_at: string; channel: ReminderChannel }[] = [];
    for (const r of reminders) {
      if (!r.date) continue; // skip incomplete rows silently
      const time = r.time || '09:00';
      const local = new Date(`${r.date}T${time}:00`);
      if (Number.isNaN(local.getTime())) return null;
      out.push({ remind_at: local.toISOString(), channel: r.channel });
    }
    return out;
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTitleTouched(true);
      return;
    }
    const remindersPayload = buildRemindersPayload();
    if (remindersPayload === null) {
      toast.error('תאריך תזכורת לא תקין');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        status: form.status,
        priority: form.priority,
        due_date: form.due_date || null,
        due_time: form.due_time || null,
        assigned_to_user_id: form.assigned_to_user_id || null,
        apartment_number: form.apartment_number.trim() || null,
        // Target is optional. A type without a value persists as no target.
        target_type: form.target_id ? form.target_type : null,
        target_id: form.target_id || null,
      };
      // Only send reminders array if it changed (replacement semantics).
      const remindersChanged =
        JSON.stringify(reminders) !== JSON.stringify(initialReminders);
      if (remindersChanged) body.reminders = remindersPayload;

      const url = isEdit ? `/api/tasks/${task!.id}` : '/api/tasks';
      const method = isEdit ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        throw new Error(
          data.error === 'title_required' ? 'כותרת היא שדה חובה' :
          isEdit ? 'עדכון המשימה נכשל' : 'יצירת המשימה נכשלה',
        );
      }
      toast.success(isEdit ? 'המשימה עודכנה' : 'המשימה נוצרה');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addComment() {
    const content = commentInput.trim();
    if (!content || !task) return;
    try {
      const r = await fetch(`/api/tasks/${task.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error('הוספת תגובה נכשלה');
      const data = (await r.json()) as { comment: TaskComment };
      setComments((prev) => [...prev, data.comment]);
      setCommentInput('');
    } catch (e) {
      toast.error((e as Error).message);
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
                  {isEdit ? 'עריכת משימה' : 'משימה חדשה'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'פרטי המשימה, שיוך, תזכורות ותגובות.'
                    : 'תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              {/* Details */}
              <Section title="פרטי המשימה" icon={ClipboardList} iconTone="blue">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="task-title" className="text-base font-medium text-muted-foreground">
                      כותרת<span className="text-red-500"> *</span>
                    </Label>
                    <Input
                      id="task-title"
                      value={form.title}
                      onChange={(e) => set('title', e.target.value)}
                      onBlur={() => setTitleTouched(true)}
                      disabled={disabled}
                      autoFocus={!isEdit}
                      placeholder="מה צריך לעשות?"
                      className={cn('h-10', titleError && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                    />
                    {titleError && (
                      <p className="text-[12px] font-semibold text-red-500 text-right">⚠️ {titleError}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="task-desc" className="text-base font-medium text-muted-foreground">תיאור</Label>
                    <Textarea
                      id="task-desc"
                      value={form.description}
                      onChange={(e) => set('description', e.target.value)}
                      disabled={disabled}
                      className="min-h-24"
                      placeholder="פירוט נוסף (אופציונלי)"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">סטטוס</Label>
                      <Select value={form.status} onValueChange={(v) => { if (v) set('status', v as TaskStatus); }} disabled={disabled}>
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue>{(v: string | null) => (v ? taskStatusLabel(v as TaskStatus) : null)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {TASK_STATUSES.map((s) => (
                            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">עדיפות</Label>
                      <Select value={form.priority} onValueChange={(v) => { if (v) set('priority', v as TaskPriority); }} disabled={disabled}>
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue>{(v: string | null) => (v ? taskPriorityLabel(v as TaskPriority) : null)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {TASK_PRIORITIES.map((p) => (
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="task-due-date" className="text-base font-medium text-muted-foreground">תאריך יעד</Label>
                      <Input
                        id="task-due-date"
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
                      <Label htmlFor="task-due-time" className="text-base font-medium text-muted-foreground">שעת יעד</Label>
                      <Input
                        id="task-due-time"
                        type="time"
                        value={form.due_time}
                        onChange={(e) => set('due_time', e.target.value)}
                        disabled={disabled}
                        dir="ltr"
                        className="h-10 cursor-pointer tabular-nums"
                      />
                    </div>
                  </div>
                </div>
              </Section>

              {/* Assignment + link */}
              <Section title="שיוך וקישור" icon={User} iconTone="violet">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">משויך אל</Label>
                    <Select
                      value={form.assigned_to_user_id || '__none__'}
                      onValueChange={(v) => { if (v) set('assigned_to_user_id', v === '__none__' ? '' : v); }}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue>
                          {(v: string | null) => {
                            if (!v || v === '__none__') return 'ללא שיוך';
                            return assignees.find((a) => a.id === v)?.name ?? 'משתמש';
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">ללא שיוך</SelectItem>
                        {assignees.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="task-apt" className="text-base font-medium text-muted-foreground">
                      מספר דירה (אופציונלי)
                    </Label>
                    <Input
                      id="task-apt"
                      value={form.apartment_number}
                      onChange={(e) => set('apartment_number', e.target.value)}
                      disabled={disabled}
                      dir="ltr"
                      placeholder="לדוגמה 42"
                      className="h-10 tabular-nums"
                    />
                  </div>
                  <TargetField
                    value={{ type: form.target_type, id: form.target_id }}
                    onChange={(t) => setForm((prev) => ({ ...prev, target_type: t.type, target_id: t.id }))}
                    disabled={disabled}
                  />
                </div>
              </Section>

              {/* Reminders */}
              <Section
                title="תזכורות"
                icon={Bell}
                iconTone="amber"
                headerSlot={
                  !disabled ? (
                    <button
                      type="button"
                      onClick={addReminder}
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200"
                    >
                      <Plus className="h-3.5 w-3.5" /> הוסף
                    </button>
                  ) : undefined
                }
              >
                <div className="space-y-3 py-2">
                  {reminders.length === 0 && (
                    <p className="py-2 text-center text-xs text-slate-400">אין תזכורות. הוסף תזכורת כדי לקבל התראה.</p>
                  )}
                  {reminders.map((r, idx) => (
                    <div key={idx} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-end">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs text-muted-foreground">תאריך</Label>
                        <Input
                          type="date"
                          value={r.date}
                          onChange={(e) => updateReminder(idx, { date: e.target.value })}
                          disabled={disabled}
                          onClick={(e) => {
                            const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                            try { el.showPicker?.(); } catch { /* */ }
                          }}
                          className="h-10 cursor-pointer"
                        />
                      </div>
                      <div className="w-full space-y-1 sm:w-28">
                        <Label className="text-xs text-muted-foreground">שעה</Label>
                        <Input
                          type="time"
                          value={r.time}
                          onChange={(e) => updateReminder(idx, { time: e.target.value })}
                          disabled={disabled}
                          dir="ltr"
                          className="h-10 cursor-pointer tabular-nums"
                        />
                      </div>
                      <div className="w-full space-y-1 sm:w-36">
                        <Label className="text-xs text-muted-foreground">ערוץ</Label>
                        <Select value={r.channel} onValueChange={(v) => { if (v) updateReminder(idx, { channel: v as ReminderChannel }); }} disabled={disabled}>
                          <SelectTrigger className="w-full data-[size=default]:h-10">
                            <SelectValue>{(v: string | null) => (v ? CHANNEL_LABEL[v as ReminderChannel] : null)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="in_app">{CHANNEL_LABEL.in_app}</SelectItem>
                            <SelectItem value="email">{CHANNEL_LABEL.email}</SelectItem>
                            <SelectItem value="both">{CHANNEL_LABEL.both}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {!disabled && (
                        <button
                          type="button"
                          onClick={() => removeReminder(idx)}
                          aria-label="הסר תזכורת"
                          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </Section>

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
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור משימה'}
          />
        </SheetContent>
      </Sheet>

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
