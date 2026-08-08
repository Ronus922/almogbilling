// Notification registry — the single source of truth mapping a notification
// `type` to its icon / tone / source module / default priority / channels.
//
// Shared by BOTH server (createNotification fan-out derives priority+channels
// from here) and client (the bell + /notifications page render icon+tone from
// here). lucide-react icons are isomorphic, so this module is safe in either
// runtime — do NOT add 'server-only'.

import {
  MessageCircle, Scale, Calendar, CheckCircle2, Clock, AlertTriangle, Bell, KeyRound,
  type LucideIcon,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';

export type NotificationType =
  | 'whatsapp_message_received'
  | 'legal_status_changed'
  | 'calendar_reminder'
  | 'task_assigned'
  | 'task_due_soon'
  | 'issue_reported'
  | 'issue_assigned'
  | 'chat_message'
  | 'internal_chat_message'
  | 'system_announcement'
  | 'chip_issued'
  | 'chip_deactivated_lost';

export type SourceModule =
  'tasks' | 'calendar' | 'whatsapp' | 'issues' | 'internal_chat' | 'legal' | 'chips' | 'system';
export type Channel = 'inapp' | 'email' | 'whatsapp';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export const PRIORITY_ORDER: Record<Priority, number> =
  { low: 0, normal: 1, high: 2, urgent: 3 };

export interface NotificationRegistryEntry {
  icon: LucideIcon;
  /** tone key → maps to DESIGN.md tokens via TONE_ICON below. */
  tone: 'info' | 'warning' | 'danger' | 'default';
  sourceModule: SourceModule;
  defaultPriority: Priority;
  /** 'inapp' is always present; 'email'/'whatsapp' are gated at fan-out time. */
  channels: Channel[];
}

export const NOTIFICATION_REGISTRY: Record<NotificationType, NotificationRegistryEntry> = {
  // In-app ONLY: an inbound WhatsApp message must never spawn an email. It lives
  // solely on the dedicated WhatsApp chat dropdown in the header (source_module
  // 'whatsapp'); outbound reply happens in /messages, not via email.
  whatsapp_message_received: { icon: MessageCircle, tone: 'info',    sourceModule: 'whatsapp',      defaultPriority: 'normal', channels: ['inapp'] },
  legal_status_changed:      { icon: Scale,         tone: 'warning', sourceModule: 'legal',         defaultPriority: 'high',   channels: ['inapp', 'email', 'whatsapp'] },
  calendar_reminder:         { icon: Calendar,      tone: 'info',    sourceModule: 'calendar',      defaultPriority: 'normal', channels: ['inapp', 'email', 'whatsapp'] },
  task_assigned:             { icon: CheckCircle2,  tone: 'default', sourceModule: 'tasks',         defaultPriority: 'normal', channels: ['inapp', 'email'] },
  task_due_soon:             { icon: Clock,         tone: 'warning', sourceModule: 'tasks',         defaultPriority: 'high',   channels: ['inapp', 'email', 'whatsapp'] },
  // In-app ONLY: the "new issue reported" admin bell must never email/WhatsApp on
  // every create. External delivery (email/WhatsApp) is opt-in via the create
  // form's NotifyMatrix, and admins are not matrix recipients. Its sole producer
  // is notifyAdminsOfIssueReported (POST /api/issues).
  issue_reported:            { icon: AlertTriangle, tone: 'danger',  sourceModule: 'issues',        defaultPriority: 'high',   channels: ['inapp'] },
  issue_assigned:            { icon: AlertTriangle, tone: 'default', sourceModule: 'issues',        defaultPriority: 'normal', channels: ['inapp', 'email'] },
  chat_message:              { icon: MessageCircle, tone: 'default', sourceModule: 'internal_chat', defaultPriority: 'low',    channels: ['inapp'] },
  internal_chat_message:     { icon: MessageCircle, tone: 'default', sourceModule: 'internal_chat', defaultPriority: 'low',    channels: ['inapp'] },
  system_announcement:       { icon: Bell,          tone: 'info',    sourceModule: 'system',        defaultPriority: 'normal', channels: ['inapp', 'email'] },
  // In-app ONLY: chip lifecycle events surface in the bell; no email/WhatsApp.
  chip_issued:               { icon: KeyRound,      tone: 'info',    sourceModule: 'chips',         defaultPriority: 'normal', channels: ['inapp'] },
  chip_deactivated_lost:     { icon: KeyRound,      tone: 'warning', sourceModule: 'chips',         defaultPriority: 'high',   channels: ['inapp'] },
};

// ── Hebrew labels ───────────────────────────────────────────────────────────
export const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'נמוכה', normal: 'רגילה', high: 'גבוהה', urgent: 'דחוף',
};

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  whatsapp_message_received: 'הודעת WhatsApp',
  legal_status_changed: 'שינוי סטטוס משפטי',
  calendar_reminder: 'תזכורת יומן',
  task_assigned: 'משימה שויכה',
  task_due_soon: 'משימה לקראת יעד',
  issue_reported: 'תקלה דווחה',
  issue_assigned: 'תקלה שויכה',
  chat_message: 'הודעה בצ׳אט',
  internal_chat_message: 'הודעה בצ׳אט',
  system_announcement: 'הודעת מערכת',
  chip_issued: 'צ׳יפ הונפק',
  chip_deactivated_lost: 'צ׳יפ אבד או נגנב',
};

export const SOURCE_MODULE_LABEL: Record<SourceModule, string> = {
  tasks: 'משימות', calendar: 'יומן', whatsapp: 'וואטסאפ', issues: 'תקלות',
  internal_chat: 'צ׳אט פנימי', legal: 'משפטי', chips: 'צ׳יפים', system: 'מערכת',
};

/** Default in-app title used when an emitter doesn't supply one (title is NOT
 *  NULL in the DB). */
export const DEFAULT_TITLE: Record<NotificationType, string> = {
  whatsapp_message_received: 'הודעת WhatsApp חדשה',
  legal_status_changed: 'סטטוס משפטי עודכן',
  calendar_reminder: 'תזכורת יומן',
  task_assigned: 'משימה חדשה שויכה אליך',
  task_due_soon: 'משימה מתקרבת ליעד',
  issue_reported: 'תקלה חדשה דווחה',
  issue_assigned: 'תקלה שויכה אליך',
  chat_message: 'הודעה חדשה בצ׳אט',
  internal_chat_message: 'הודעה חדשה בצ׳אט',
  system_announcement: 'הודעת מערכת',
  chip_issued: 'צ׳יפ חדש הונפק',
  chip_deactivated_lost: 'צ׳יפ הושבת — אבד או נגנב',
};

// ── UI token maps (DESIGN.md §2 tones / §10 pills) ───────────────────────────
/** Icon chip background+foreground per tone (DESIGN.md §2 Tone Variants). */
export const TONE_ICON: Record<NotificationRegistryEntry['tone'], string> = {
  info: 'bg-blue-50 text-blue-600',
  warning: 'bg-amber-50 text-amber-600',
  danger: 'bg-rose-50 text-rose-600',
  default: 'bg-slate-100 text-slate-600',
};

/** Priority pill classes (DESIGN.md §10 — rounded-full pill, soft tone). */
export const PRIORITY_PILL: Record<Priority, string> = {
  low: 'bg-slate-100 text-slate-600',
  normal: 'bg-blue-50 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-rose-100 text-rose-700',
};

// ── Visual resolution (handles legacy / unknown stored types gracefully) ──────
interface NotificationVisual {
  icon: LucideIcon;
  toneClass: string;
  label: string;
}

// Legacy `type` strings written before this registry existed (and ones not in
// the typed union) still need a sensible icon/tone in the bell + page.
const LEGACY_VISUAL: Record<string, NotificationVisual> = {
  reminder: { icon: Clock, toneClass: TONE_ICON.info, label: 'תזכורת' },
  issue_status_changed: { icon: AlertTriangle, toneClass: TONE_ICON.warning, label: 'שינוי סטטוס תקלה' },
};

/** Resolve icon + tone-class + Hebrew label for ANY stored notification type. */
export function getNotificationVisual(type: string): NotificationVisual {
  const reg = NOTIFICATION_REGISTRY[type as NotificationType];
  if (reg) {
    return {
      icon: reg.icon,
      toneClass: TONE_ICON[reg.tone],
      label: NOTIFICATION_TYPE_LABEL[type as NotificationType],
    };
  }
  return LEGACY_VISUAL[type] ?? { icon: Bell, toneClass: TONE_ICON.default, label: type };
}

/** Hebrew relative time, e.g. "לפני 5 דקות". Falls back to '' on bad input.
 *  NOTE: `Date.now()`-derived → differs between SSR and hydration. Render it only
 *  after mount (useHasMounted); use formatAbsoluteTime() as the pre-mount value. */
export function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : formatDistanceToNow(d, { addSuffix: true, locale: he });
}

const ABS_TIME_FMT = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Deterministic absolute stamp (Asia/Jerusalem) — SSR-safe, used pre-mount in
 *  place of the time-relative formatRelativeTime(). */
export function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : ABS_TIME_FMT.format(d);
}

/** Input for the server-side fan-out createNotification(). */
export interface CreateNotificationServiceInput {
  userId: string;
  type: NotificationType;
  message: string;
  title?: string;
  priority?: Priority;
  sourceModule?: SourceModule;
  sourceEntityType?: string;
  sourceEntityId?: string;
  actionUrl?: string;
  dedupeKey?: string;
  /** Extra addresses CC'd on the email channel (e.g. a legal status's
   *  notification_emails). Sent through the SAME email path — no split logic. */
  extraEmails?: string[];
}
