import 'server-only';
import { listTasks, getTaskKpis, listTasksWithDueDateInRange } from '@/lib/db/tasks';
import { listIssues, getIssueKpis, listIssuesWithDueDateInRange } from '@/lib/db/issues';
import { listUserReminders, listUserRemindersInRange } from '@/lib/db/userReminders';
import { listEventsInRange } from '@/lib/db/calendarEvents';
import { listConversations, countUnreadConversations } from '@/lib/db/whatsappConversations';
import { todayInJerusalem } from '@/lib/dates';
import type { TaskPriority } from '@/lib/types/tasks';
import type { IssuePriority } from '@/lib/types/issues';
import { logger } from '@/lib/logger';

// How many rows each list widget shows before the "הצג הכל" link.
const WIDGET_LIMIT = 5;

// ── Period selector ─────────────────────────────────────────────────────────
export type Period = 'month' | 'quarter' | 'year';
export const PERIODS: readonly Period[] = ['month', 'quarter', 'year'] as const;

/** Months of snapshot history the chart spans for a given period granularity.
 *  (Only monthly snapshots exist, so "quarter"/"year" widen the month window.) */
export function monthsForPeriod(p: Period): number {
  return p === 'year' ? 24 : p === 'quarter' ? 12 : 6;
}

/** Current 'YYYY-MM' in Jerusalem — the calendar's default month. */
export function currentYm(): string {
  return todayInJerusalem().slice(0, 7);
}

/**
 * Run a widget loader, swallowing any failure to null so one widget's error
 * (a DB hiccup, or a permission the loader's query enforces) never blanks the
 * whole overview — the widget renders its own empty/error state instead.
 */
export async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.error('[overview:widget]', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Tasks ───────────────────────────────────────────────────────────────────
export interface TaskRow {
  id: string;
  title: string;
  priority: TaskPriority;
  due_date: string | null;
  due_time: string | null;
  target_label: string | null;
  assignee: string | null;
}
export interface TasksWidget {
  items: TaskRow[];
  count: number;
}

export async function loadTasks(): Promise<TasksWidget> {
  const [list, kpis] = await Promise.all([
    listTasks({ sort: 'due_asc' }),
    getTaskKpis(),
  ]);
  const items = list
    .filter((t) => t.status === 'open' || t.status === 'in_progress')
    .slice(0, WIDGET_LIMIT)
    .map((t): TaskRow => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      due_date: t.due_date,
      due_time: t.due_time ? t.due_time.slice(0, 5) : null,
      target_label: t.target_label ?? t.apartment_number,
      assignee:
        t.assignees.map((a) => a.display_name).filter(Boolean).join(', ') || null,
    }));
  return { items, count: kpis.open };
}

// ── Issues ──────────────────────────────────────────────────────────────────
export interface IssueRow {
  id: string;
  title: string;
  priority: IssuePriority;
  location: string | null;
  created_at: string;
}
export interface IssuesWidget {
  items: IssueRow[];
  count: number;
}

export async function loadIssues(): Promise<IssuesWidget> {
  const [list, kpis] = await Promise.all([
    listIssues({ sort: 'priority_desc' }),
    getIssueKpis(),
  ]);
  const items = list
    .filter((i) => i.status === 'open' || i.status === 'in_progress')
    .slice(0, WIDGET_LIMIT)
    .map((i): IssueRow => ({
      id: i.id,
      title: i.title,
      priority: i.priority,
      location: i.target_label ?? i.location_text,
      created_at: i.created_at,
    }));
  return { items, count: kpis.open };
}

// ── Reminders (the actor's own pending) ──────────────────────────────────────
export interface ReminderRow {
  id: string;
  title: string;
  remind_at: string;
  category_color: string | null;
}
export interface RemindersWidget {
  items: ReminderRow[];
  count: number;
}

export async function loadReminders(userId: string): Promise<RemindersWidget> {
  const list = await listUserReminders({ status: 'pending', involvingUser: userId });
  const items = list.slice(0, WIDGET_LIMIT).map((r): ReminderRow => ({
    id: r.id,
    title: r.title,
    remind_at: r.remind_at,
    category_color: r.category_color,
  }));
  return { items, count: list.length };
}

// ── WhatsApp (unread conversations) ──────────────────────────────────────────
export interface WhatsappRow {
  chat_id: string;
  name: string;
  apartment: string | null;
  last: string | null;
  at: string;
  unread: number;
  avatar_url: string | null;
  is_group: boolean;
}
export interface WhatsappWidget {
  items: WhatsappRow[];
  count: number;
}

export async function loadWhatsapp(): Promise<WhatsappWidget> {
  const [convos, count] = await Promise.all([
    listConversations('', null, 50),
    countUnreadConversations(),
  ]);
  const items = convos
    .filter((c) => c.unread > 0)
    .slice(0, WIDGET_LIMIT)
    .map((c): WhatsappRow => ({
      chat_id: c.chat_id,
      name: c.display_name || (c.is_group ? 'קבוצה' : c.phone) || 'ללא שם',
      apartment: c.apartment_number,
      last: c.last_content,
      at: c.last_at,
      unread: c.unread,
      avatar_url: c.avatar_url,
      is_group: c.is_group,
    }));
  return { items, count };
}

// ── Calendar (month grid with colored dots) ──────────────────────────────────
export type CalKind = 'task' | 'issue' | 'reminder' | 'event';
export interface CalendarMonthData {
  ym: string;
  year: number;
  month: number; // 1-12
  firstWeekday: number; // 0=Sun … 6=Sat (weekday of the 1st)
  daysInMonth: number;
  prevYm: string;
  nextYm: string;
  todayDay: number | null; // day-of-month if today is in this month, else null
  kindsByDay: Record<number, CalKind[]>;
}

function shiftYm(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function loadCalendarMonth(
  ym: string,
  userId: string,
  canReminders: boolean,
): Promise<CalendarMonthData> {
  const [y, m] = ym.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${ym}-01`;
  const to = `${ym}-${String(daysInMonth).padStart(2, '0')}`;

  const [events, tasks, issues, reminders] = await Promise.all([
    listEventsInRange(from, to),
    listTasksWithDueDateInRange(from, to),
    listIssuesWithDueDateInRange(from, to),
    canReminders ? listUserRemindersInRange(from, to, userId) : Promise.resolve([]),
  ]);

  const sets: Record<number, Set<CalKind>> = {};
  const add = (dateStr: string, kind: CalKind) => {
    const day = Number(dateStr.slice(8, 10));
    (sets[day] ??= new Set()).add(kind);
  };
  events.forEach((e) => add(e.event_date, 'event'));
  // Only still-open tasks paint a dot — mirrors the issue overlay (which already
  // hides resolved/closed) so a completed task doesn't read as pending.
  tasks
    .filter((t) => t.status === 'open' || t.status === 'in_progress')
    .forEach((t) => add(t.due_date, 'task'));
  issues.forEach((i) => add(i.due_date, 'issue'));
  reminders.forEach((r) => add(r.event_date, 'reminder'));

  const ORDER: CalKind[] = ['task', 'issue', 'reminder', 'event'];
  const kindsByDay: Record<number, CalKind[]> = {};
  for (const [day, set] of Object.entries(sets)) {
    kindsByDay[Number(day)] = ORDER.filter((k) => set.has(k));
  }

  const today = todayInJerusalem();
  const todayDay = today.slice(0, 7) === ym ? Number(today.slice(8, 10)) : null;

  return {
    ym,
    year: y,
    month: m,
    firstWeekday,
    daysInMonth,
    prevYm: shiftYm(ym, -1),
    nextYm: shiftYm(ym, 1),
    todayDay,
    kindsByDay,
  };
}
