import type { BulkSendProgress, BulkSendSummary, BulkSendWaiting } from '@/types/whatsapp';

// One line of the NDJSON stream POST /api/whatsapp/send-bulk answers with. Kept
// out of the panel so the rule "a line of a type the panel does not know is
// ignored" has a test: the panel used to treat EVERY non-progress line as the
// final summary, so the first new line type would have been taken for one.

export type BulkStreamEvent = BulkSendProgress | BulkSendWaiting | BulkSendSummary;

export function parseBulkLine(line: string): BulkStreamEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const type = (obj as { type?: unknown }).type;
  if (type === 'progress' || type === 'waiting' || type === 'summary') return obj as BulkStreamEvent;
  return null;
}
