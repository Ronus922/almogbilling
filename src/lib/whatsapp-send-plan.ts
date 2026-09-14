import { WHATSAPP_ATTACHMENT_LIMITS } from '@/lib/constants/whatsappAttachments';

// What one outbound WhatsApp message turns into on the wire, in order. Pure —
// the same rule the broadcast worker follows (src/lib/wa-queue/attachments.ts
// planSteps), minus the per-recipient resume bookkeeping the queue needs:
//   • no files          → the text, as a message
//   • exactly one file  → the file, with the text as its caption (one send)
//   • several files     → the text first, then the files in order
// A caption longer than Green API's 1024 chars cannot ride along, so the text
// goes out as its own message even with a single file.

export type MessageSendStep =
  | { kind: 'text' }
  | { kind: 'file'; index: number; caption?: string };

export function planMessageSends(
  text: string,
  fileCount: number,
  captionMax: number = WHATSAPP_ATTACHMENT_LIMITS.captionMaxChars,
): MessageSendStep[] {
  const body = text.trim();
  if (fileCount <= 0) return body ? [{ kind: 'text' }] : [];
  if (fileCount === 1 && body.length <= captionMax) {
    return [{ kind: 'file', index: 0, ...(body ? { caption: body } : {}) }];
  }
  const steps: MessageSendStep[] = body ? [{ kind: 'text' }] : [];
  for (let i = 0; i < fileCount; i++) steps.push({ kind: 'file', index: i });
  return steps;
}
