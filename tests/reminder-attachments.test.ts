import { describe, expect, it } from 'vitest';
import {
  REMINDER_ATTACHMENT_ACCEPT, REMINDER_ATTACHMENT_LIMITS, reminderAttachmentHelpText, reminderAttachmentMime,
  validateReminderAttachment, validateReminderAttachmentSet,
} from '@/lib/constants/reminderAttachments';
import {
  REMINDER_DESCRIPTION_MAX, coerceAttachmentIds, coerceUserReminderInput,
} from '@/lib/validation/userReminders';

// Reminder description + attachments (05/10/2026): the file policy the panel
// pre-checks and the upload route enforces, and the body rules of
// POST /api/user-reminders + PATCH /api/user-reminders/[id].

const MB = 1024 * 1024;
const ID = '0b6f5d1e-7a3c-4c1f-9a51-3a1f0c0e2b77';

describe('reminder attachment policy — PDF, images, Word, Excel · 10 files · 20MB', () => {
  it('accepts the four families and nothing else', () => {
    for (const name of ['a.pdf', 'b.JPG', 'c.jpeg', 'd.png', 'e.webp', 'f.doc', 'g.docx', 'h.xls', 'i.xlsx']) {
      expect(validateReminderAttachment({ name, size: MB, type: '' }), name).toBeNull();
    }
    for (const name of ['a.mp4', 'b.zip', 'c.txt', 'd.csv', 'e.pptx', 'noext']) {
      expect(validateReminderAttachment({ name, size: MB, type: '' }), name).toBe('סוג הקובץ אינו נתמך');
    }
    expect(REMINDER_ATTACHMENT_ACCEPT).toBe('.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx');
    expect(reminderAttachmentHelpText()).toBe('PDF, תמונות, Word, Excel · עד 10 קבצים, 20MB לקובץ');
  });

  it('the extension decides the MIME; Office reported as ZIP (Chrome on Windows) is still accepted', () => {
    expect(reminderAttachmentMime('הסכם.DOCX')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(reminderAttachmentMime('x.zip')).toBeNull();
    expect(validateReminderAttachment({ name: 'x.docx', size: 10, type: 'application/zip' })).toBeNull();
    expect(validateReminderAttachment({ name: 'x.xlsx', size: 10, type: 'application/x-zip-compressed' })).toBeNull();
    expect(validateReminderAttachment({ name: 'x.pdf', size: 10, type: 'application/octet-stream' })).toBeNull();
    expect(validateReminderAttachment({ name: 'x.pdf', size: 10, type: 'image/png' })).toMatch(/אינו תואם/);
  });

  it('caps a file at 20MB and refuses an empty one', () => {
    expect(REMINDER_ATTACHMENT_LIMITS.maxBytes).toBe(20 * MB);
    expect(validateReminderAttachment({ name: 'x.pdf', size: 20 * MB, type: '' })).toBeNull();
    expect(validateReminderAttachment({ name: 'x.pdf', size: 20 * MB + 1, type: '' })).toBe('הקובץ גדול מ-20MB');
    expect(validateReminderAttachment({ name: 'x.pdf', size: 0, type: '' })).toBe('הקובץ ריק');
  });

  it('caps a reminder at 10 files — the message always names the reminder cap', () => {
    const nine = Array.from({ length: 9 }, () => ({ size: 1 }));
    expect(validateReminderAttachmentSet(nine, [{ size: 1 }])).toBeNull();
    expect(validateReminderAttachmentSet(nine, [{ size: 1 }, { size: 1 }])).toBe('ניתן לצרף עד 10 קבצים');
    // The edit panel passes the slots left after the saved files.
    expect(validateReminderAttachmentSet([], [{ size: 1 }], 0)).toBe('ניתן לצרף עד 10 קבצים');
  });
});

describe('reminder body — description', () => {
  it('is optional, trimmed, and blank means NULL', () => {
    const create = { title: 'x', remind_at: '2026-10-05T06:00:00.000Z' };
    expect(coerceUserReminderInput(create, 'create')).toEqual({ ok: true, fields: { title: 'x', remind_at: create.remind_at } });
    expect(coerceUserReminderInput({ ...create, description: '  שורה\nשנייה  ' }, 'create'))
      .toMatchObject({ ok: true, fields: { description: 'שורה\nשנייה' } });
    expect(coerceUserReminderInput({ description: '   ' }, 'update')).toEqual({ ok: true, fields: { description: null } });
    expect(coerceUserReminderInput({ description: null }, 'update')).toEqual({ ok: true, fields: { description: null } });
  });

  it('a status-only PATCH does not touch the description', () => {
    expect(coerceUserReminderInput({ status: 'done' }, 'update')).toEqual({ ok: true, fields: { status: 'done' } });
  });

  it('refuses more than 1000 characters and a non-string', () => {
    expect(REMINDER_DESCRIPTION_MAX).toBe(1000);
    expect(coerceUserReminderInput({ description: 'א'.repeat(1000) }, 'update').ok).toBe(true);
    expect(coerceUserReminderInput({ description: 'א'.repeat(1001) }, 'update'))
      .toEqual({ ok: false, error: 'description_too_long' });
    expect(coerceUserReminderInput({ description: 5 }, 'update')).toEqual({ ok: false, error: 'invalid_description' });
  });
});

describe('reminder body — attachment_ids', () => {
  it('absent or null = none (the list\'s status toggle sends no files)', () => {
    expect(coerceAttachmentIds({})).toEqual({ ok: true, ids: [] });
    expect(coerceAttachmentIds({ attachment_ids: null })).toEqual({ ok: true, ids: [] });
  });

  it('distinct UUIDs only', () => {
    expect(coerceAttachmentIds({ attachment_ids: [ID, ID] })).toEqual({ ok: true, ids: [ID] });
    expect(coerceAttachmentIds({ attachment_ids: ID })).toEqual({ ok: false, error: 'invalid_attachment_ids' });
    expect(coerceAttachmentIds({ attachment_ids: ['nope'] })).toEqual({ ok: false, error: 'invalid_attachment_ids' });
    expect(coerceAttachmentIds({ attachment_ids: [1] })).toEqual({ ok: false, error: 'invalid_attachment_ids' });
  });

  it('at most one reminder\'s worth (10)', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `0b6f5d1e-7a3c-4c1f-9a51-3a1f0c0e2b${String(i).padStart(2, '0')}`);
    expect(coerceAttachmentIds({ attachment_ids: ids.slice(0, 10) }).ok).toBe(true);
    expect(coerceAttachmentIds({ attachment_ids: ids })).toEqual({ ok: false, error: 'too_many_attachments' });
  });
});
