import { describe, it, expect } from 'vitest';
import {
  chatIdToLocalPhone,
  parseWebhookNotification,
  parseLastIncomingItem,
} from '@/lib/whatsapp';

describe('chatIdToLocalPhone — Green API chatId → DB-canonical local', () => {
  it('person chat "972…@c.us" → local "0…"', () => {
    expect(chatIdToLocalPhone('972541234567@c.us')).toBe('0541234567');
    expect(chatIdToLocalPhone('972521112222@c.us')).toBe('0521112222');
  });

  it('accepts bare digits with no @suffix', () => {
    expect(chatIdToLocalPhone('972541234567')).toBe('0541234567');
  });

  it('group / broadcast chats are rejected', () => {
    expect(chatIdToLocalPhone('120363012345678901@g.us')).toBeNull();
    expect(chatIdToLocalPhone('status@broadcast')).toBeNull();
  });

  it('empty / null / junk → null', () => {
    expect(chatIdToLocalPhone('')).toBeNull();
    expect(chatIdToLocalPhone(null)).toBeNull();
    expect(chatIdToLocalPhone('abc@c.us')).toBeNull();
    expect(chatIdToLocalPhone('0000000000@c.us')).toBeNull();
  });
});

describe('parseWebhookNotification — live webhook POST body', () => {
  const base = {
    typeWebhook: 'incomingMessageReceived',
    timestamp: 1700000000,
    idMessage: 'ABC123',
    senderData: { chatId: '972521112222@c.us', sender: '972521112222@c.us', senderName: 'דייר' },
  };

  it('text message → normalised ParsedIncoming', () => {
    expect(parseWebhookNotification({
      ...base,
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'שלום' } },
    })).toEqual({
      externalMessageId: 'ABC123',
      chatId: '972521112222@c.us',
      senderPhoneLocal: '0521112222',
      messageType: 'text',
      content: 'שלום',
      timestamp: 1700000000,
    });
  });

  it('extendedTextMessage → text from extendedTextMessageData.text', () => {
    const out = parseWebhookNotification({
      ...base,
      messageData: { typeMessage: 'extendedTextMessage', extendedTextMessageData: { text: 'הי' } },
    });
    expect(out?.messageType).toBe('text');
    expect(out?.content).toBe('הי');
  });

  it('imageMessage → image with downloadUrl as content', () => {
    const out = parseWebhookNotification({
      ...base,
      messageData: {
        typeMessage: 'imageMessage',
        fileMessageData: { downloadUrl: 'https://media.green-api.com/x.jpg', caption: 'c', fileName: 'x.jpg' },
      },
    });
    expect(out?.messageType).toBe('image');
    expect(out?.content).toBe('https://media.green-api.com/x.jpg');
  });

  it('documentMessage / audioMessage → document with downloadUrl', () => {
    const doc = parseWebhookNotification({
      ...base,
      messageData: { typeMessage: 'documentMessage', fileMessageData: { downloadUrl: 'https://m/d.pdf' } },
    });
    expect(doc?.messageType).toBe('document');
    expect(doc?.content).toBe('https://m/d.pdf');

    const audio = parseWebhookNotification({
      ...base,
      messageData: { typeMessage: 'audioMessage', fileMessageData: { downloadUrl: 'https://m/a.ogg' } },
    });
    expect(audio?.messageType).toBe('document');
  });

  it('non-incoming notifications → null', () => {
    expect(parseWebhookNotification({ ...base, typeWebhook: 'outgoingMessageStatus' })).toBeNull();
    expect(parseWebhookNotification({ ...base, typeWebhook: 'stateInstanceChanged' })).toBeNull();
  });

  it('missing idMessage / chatId → null', () => {
    expect(parseWebhookNotification({
      ...base, idMessage: undefined,
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'x' } },
    })).toBeNull();
    expect(parseWebhookNotification({
      ...base, senderData: {},
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'x' } },
    })).toBeNull();
  });

  it('group chat → null', () => {
    expect(parseWebhookNotification({
      ...base, senderData: { chatId: '120363000000000000@g.us' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'x' } },
    })).toBeNull();
  });

  it('unsupported message type / empty text → null', () => {
    expect(parseWebhookNotification({
      ...base, messageData: { typeMessage: 'pollMessage' },
    })).toBeNull();
    expect(parseWebhookNotification({
      ...base, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: '   ' } },
    })).toBeNull();
  });

  it('non-object payloads → null', () => {
    expect(parseWebhookNotification(null)).toBeNull();
    expect(parseWebhookNotification('')).toBeNull();
    expect(parseWebhookNotification(42)).toBeNull();
  });
});

describe('parseLastIncomingItem — lastIncomingMessages pull item (flattened)', () => {
  it('text item → ParsedIncoming', () => {
    expect(parseLastIncomingItem({
      type: 'incoming',
      idMessage: 'P1',
      timestamp: 1700000001,
      typeMessage: 'textMessage',
      chatId: '972521113333@c.us',
      textMessage: 'מהמשיכה',
    })).toEqual({
      externalMessageId: 'P1',
      chatId: '972521113333@c.us',
      senderPhoneLocal: '0521113333',
      messageType: 'text',
      content: 'מהמשיכה',
      timestamp: 1700000001,
    });
  });

  it('extendedTextMessage item → text from extendedTextMessage.text', () => {
    const out = parseLastIncomingItem({
      idMessage: 'P2',
      typeMessage: 'extendedTextMessage',
      chatId: '972521114444@c.us',
      extendedTextMessage: { text: 'הרחבה' },
    });
    expect(out?.messageType).toBe('text');
    expect(out?.content).toBe('הרחבה');
  });

  it('imageMessage item → image with downloadUrl', () => {
    const out = parseLastIncomingItem({
      idMessage: 'P3',
      typeMessage: 'imageMessage',
      chatId: '972521115555@c.us',
      downloadUrl: 'https://m/z.png',
    });
    expect(out?.messageType).toBe('image');
    expect(out?.content).toBe('https://m/z.png');
  });

  it('missing idMessage → null', () => {
    expect(parseLastIncomingItem({ typeMessage: 'textMessage', chatId: '972521116666@c.us', textMessage: 'x' })).toBeNull();
  });

  it('timestamp absent → null timestamp (DB default applies)', () => {
    const out = parseLastIncomingItem({
      idMessage: 'P4', typeMessage: 'textMessage', chatId: '972521117777@c.us', textMessage: 'x',
    });
    expect(out?.timestamp).toBeNull();
  });
});
