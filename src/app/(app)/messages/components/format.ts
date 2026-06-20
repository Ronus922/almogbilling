import { formatPhoneDisplay } from '@/lib/phone';
import type { Conversation, ChatMessageType } from '@/types/whatsapp';

// Small display helpers shared by the conversation list and the thread.

export function conversationTitle(c: Conversation): string {
  if (c.display_name) return c.display_name;
  // Supplier-linked conversations have no debtor display_name — show the supplier
  // name as the title (XOR: a chat is debtor- OR supplier-linked, never both).
  if (c.supplier_id && c.supplier_display_name) return c.supplier_display_name;
  if (c.is_group) return 'קבוצת וואטסאפ';
  return (c.phone && formatPhoneDisplay(c.phone)) || 'לא ידוע';
}

export function previewText(content: string | null, type: ChatMessageType): string {
  if (type === 'image') return '📷 תמונה';
  if (type === 'document') return '📎 קובץ';
  return (content ?? '').trim();
}

/** Role line for a debtor-linked conversation: "בעלים" or "שוכר: {name}" (the
 *  name is dropped when it would just repeat the title). null for supplier /
 *  unlinked / unknown — a supplier chat is marked by the "ספק" badge instead. */
export function roleLine(c: Conversation): string | null {
  if (!c.debtor_id) return null;
  if (c.role === 'owner') return 'בעלים';
  if (c.role === 'tenant') {
    const name = (c.tenant_name ?? '').trim();
    return name && name !== c.display_name ? `שוכר: ${name}` : 'שוכר';
  }
  return null;
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
