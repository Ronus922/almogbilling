import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_ATTACHMENT_LIMITS,
  WHATSAPP_MESSAGE_MAX_FILES,
  attachmentMessageType,
  validateBroadcastAttachmentSet,
} from '@/lib/constants/whatsappAttachments';
import { messageAttachmentIdsSchema } from '@/lib/validation/requests';
import { planMessageSends } from '@/lib/whatsapp-send-plan';
import { greenMediaHost } from '@/lib/whatsapp';
import { mediaBaseFor } from '@/lib/wa-queue/provider';

// The single-recipient message path: five files instead of the broadcast's ten,
// the same type/size policy, and the order the recipient receives them in.

const MB = 1024 * 1024;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('one message: at most five attachments', () => {
  it('the cap is five, and lower than the broadcast cap', () => {
    expect(WHATSAPP_MESSAGE_MAX_FILES).toBe(5);
    expect(WHATSAPP_MESSAGE_MAX_FILES).toBeLessThan(WHATSAPP_ATTACHMENT_LIMITS.maxFiles);
  });

  it('client rule: the sixth file is refused, the first five are not', () => {
    const attached = (n: number) => Array.from({ length: n }, () => ({ size: MB }));
    for (let n = 0; n < WHATSAPP_MESSAGE_MAX_FILES; n++) {
      expect(validateBroadcastAttachmentSet(attached(n), [{ size: MB }], WHATSAPP_MESSAGE_MAX_FILES)).toBeNull();
    }
    expect(validateBroadcastAttachmentSet(attached(5), [{ size: MB }], WHATSAPP_MESSAGE_MAX_FILES))
      .toMatch(/עד 5 קבצים/);
    // …while the broadcast keeps its own, higher cap.
    expect(validateBroadcastAttachmentSet(attached(5), [{ size: MB }])).toBeNull();
    expect(validateBroadcastAttachmentSet(attached(9), [{ size: MB }])).toBeNull();
    expect(validateBroadcastAttachmentSet(attached(10), [{ size: MB }])).toMatch(/עד 10 קבצים/);
  });

  it('server rule: the request schema refuses a sixth id', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));
    expect(messageAttachmentIdsSchema.safeParse(ids(5)).success).toBe(true);
    const six = messageAttachmentIdsSchema.safeParse(ids(6));
    expect(six.success).toBe(false);
    expect(six.error?.issues[0]?.message).toMatch(/עד 5 קבצים/);
    // absent / empty is a plain text message
    expect(messageAttachmentIdsSchema.safeParse(undefined).data).toEqual([]);
    expect(messageAttachmentIdsSchema.safeParse(['not-a-uuid']).success).toBe(false);
  });

  it('the total-size rule is shared with the broadcast', () => {
    expect(validateBroadcastAttachmentSet([{ size: 60 * MB }], [{ size: 40 * MB }], WHATSAPP_MESSAGE_MAX_FILES)).toBeNull();
    expect(validateBroadcastAttachmentSet([{ size: 60 * MB }], [{ size: 41 * MB }], WHATSAPP_MESSAGE_MAX_FILES))
      .toMatch(/חורג מ-100MB/);
  });
});

describe('what one message turns into on the wire', () => {
  it('text only', () => {
    expect(planMessageSends('שלום', 0)).toEqual([{ kind: 'text' }]);
    expect(planMessageSends('   ', 0)).toEqual([]);
  });

  it('a single file carries the text as its caption — one send, not two', () => {
    expect(planMessageSends('שלום', 1)).toEqual([{ kind: 'file', index: 0, caption: 'שלום' }]);
    expect(planMessageSends('', 1)).toEqual([{ kind: 'file', index: 0 }]);
  });

  it('a caption too long for WhatsApp goes as its own message first', () => {
    const long = 'x'.repeat(WHATSAPP_ATTACHMENT_LIMITS.captionMaxChars + 1);
    expect(planMessageSends(long, 1)).toEqual([{ kind: 'text' }, { kind: 'file', index: 0 }]);
    const exact = 'x'.repeat(WHATSAPP_ATTACHMENT_LIMITS.captionMaxChars);
    expect(planMessageSends(exact, 1)).toEqual([{ kind: 'file', index: 0, caption: exact }]);
  });

  it('several files: the text first, then every file in order', () => {
    expect(planMessageSends('שלום', 3)).toEqual([
      { kind: 'text' }, { kind: 'file', index: 0 }, { kind: 'file', index: 1 }, { kind: 'file', index: 2 },
    ]);
    expect(planMessageSends('', 5)).toEqual([
      { kind: 'file', index: 0 }, { kind: 'file', index: 1 }, { kind: 'file', index: 2 },
      { kind: 'file', index: 3 }, { kind: 'file', index: 4 },
    ]);
  });
});

describe('the parent chat_messages row', () => {
  it('is tagged by the first file, and video/audio count as a document', () => {
    // chat_messages.message_type CHECK allows only text | image | document.
    expect(attachmentMessageType('תמונה.jpg')).toBe('image');
    expect(attachmentMessageType('photo.PNG')).toBe('image');
    expect(attachmentMessageType('חוזה.pdf')).toBe('document');
    expect(attachmentMessageType('clip.mp4')).toBe('document');
    expect(attachmentMessageType('voice.m4a')).toBe('document');
    expect(attachmentMessageType('גיליון.xlsx')).toBe('document');
  });
});

describe('Green API media host', () => {
  it('the direct client and the queue provider derive it identically', () => {
    // Two copies on purpose (the worker module must stay import-free, this one
    // is reachable from client components) — they may never disagree.
    for (const host of [
      undefined, 'https://api.green-api.com', 'https://api.greenapi.com',
      'https://7103.api.greenapi.com', 'https://custom.example.com', 'https://api.green-api.com/',
    ]) {
      expect(greenMediaHost(host)).toBe(mediaBaseFor(host));
    }
  });
});
