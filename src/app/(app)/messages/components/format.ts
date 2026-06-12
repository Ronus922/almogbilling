import { formatPhoneDisplay } from '@/lib/phone';
import type { Conversation, ChatMessageType } from '@/types/whatsapp';

// Small display helpers shared by the conversation list and the thread.

export function conversationTitle(c: Conversation): string {
  if (c.display_name) return c.display_name;
  if (c.is_group) return 'קבוצת וואטסאפ';
  return (c.phone && formatPhoneDisplay(c.phone)) || 'לא ידוע';
}

export function previewText(content: string | null, type: ChatMessageType): string {
  if (type === 'image') return '📷 תמונה';
  if (type === 'document') return '📎 קובץ';
  return (content ?? '').trim();
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "היום" / "אתמול" / dd/mm/yyyy — the day separator inside a thread. */
export function formatRelativeDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000);
  if (diffDays === 0) return 'היום';
  if (diffDays === 1) return 'אתמול';
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Time for today, else short date — the conversation-list stamp. */
export function formatListStamp(iso: string): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return formatTime(iso);
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' }).format(d);
}
