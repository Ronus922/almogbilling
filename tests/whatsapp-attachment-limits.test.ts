import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_ATTACHMENT_LIMITS,
  WHATSAPP_ATTACHMENT_ACCEPT,
  attachmentExt,
  attachmentKind,
  canonicalMime,
  validateBroadcastAttachment,
  validateBroadcastAttachmentSet,
} from '@/lib/constants/whatsappAttachments';

// The one policy the compose tab (pre-check) and the upload route (authority)
// share for broadcast attachments. Pure — no DOM, no DB.

const MB = 1024 * 1024;

describe('broadcast attachment limits', () => {
  it('classifies every allowed extension into exactly one kind with a canonical MIME', () => {
    const all = Object.values(WHATSAPP_ATTACHMENT_LIMITS.kinds).flatMap((k) => k.exts);
    expect(new Set(all).size).toBe(all.length);
    for (const ext of all) {
      expect(attachmentKind(ext)).not.toBeNull();
      expect(canonicalMime(ext)).toMatch(/\//);
      expect(WHATSAPP_ATTACHMENT_ACCEPT).toContain(`.${ext}`);
    }
    expect(attachmentKind('exe')).toBeNull();
    expect(attachmentKind('')).toBeNull();
  });

  it('extension is lower-cased and taken from the last dot only', () => {
    expect(attachmentExt('דוח.PDF')).toBe('pdf');
    expect(attachmentExt('archive.tar.gz')).toBe('gz');
    expect(attachmentExt('noext')).toBe('');
  });

  it('accepts a typical file of every kind and rejects the unsupported', () => {
    expect(validateBroadcastAttachment({ name: 'חשבון.pdf', size: 5 * MB, type: 'application/pdf' })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'photo.JPG', size: 2 * MB, type: 'image/jpeg' })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'clip.mp4', size: 10 * MB, type: 'video/mp4' })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'voice.m4a', size: MB, type: 'audio/x-m4a' })).toBeNull();
    // Browsers often report octet-stream / nothing for Office & csv — allowed.
    expect(validateBroadcastAttachment({ name: 'data.csv', size: MB, type: '' })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'data.xlsx', size: MB, type: 'application/octet-stream' })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'virus.exe', size: MB, type: 'application/octet-stream' })).toMatch(/אינו נתמך/);
    expect(validateBroadcastAttachment({ name: 'page.html', size: MB, type: 'text/html' })).toMatch(/אינו נתמך/);
  });

  it('rejects a MIME that contradicts the extension', () => {
    expect(validateBroadcastAttachment({ name: 'fake.pdf', size: MB, type: 'text/html' })).toMatch(/אינו תואם/);
    expect(validateBroadcastAttachment({ name: 'fake.png', size: MB, type: 'application/pdf' })).toMatch(/אינו תואם/);
  });

  it('enforces the per-kind size caps and rejects empty files', () => {
    const { image, video, audio, document } = WHATSAPP_ATTACHMENT_LIMITS.kinds;
    expect(validateBroadcastAttachment({ name: 'a.png', size: image.maxBytes, type: 'image/png' })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'a.png', size: image.maxBytes + 1, type: 'image/png' })).toMatch(/תמונות עד/);
    expect(validateBroadcastAttachment({ name: 'a.mp4', size: video.maxBytes + 1 })).toMatch(/וידאו עד/);
    expect(validateBroadcastAttachment({ name: 'a.mp3', size: audio.maxBytes + 1 })).toMatch(/אודיו עד/);
    expect(validateBroadcastAttachment({ name: 'a.pdf', size: document.maxBytes })).toBeNull();
    expect(validateBroadcastAttachment({ name: 'a.pdf', size: document.maxBytes + 1 })).toMatch(/מסמכים עד/);
    expect(validateBroadcastAttachment({ name: 'a.pdf', size: 0 })).toMatch(/ריק/);
  });

  it('documents never exceed what Green API or the storage accept', () => {
    expect(WHATSAPP_ATTACHMENT_LIMITS.kinds.document.maxBytes).toBeLessThanOrEqual(100 * MB);
    expect(WHATSAPP_ATTACHMENT_LIMITS.kinds.document.maxBytes).toBeLessThanOrEqual(50 * MB);
    expect(WHATSAPP_ATTACHMENT_LIMITS.captionMaxChars).toBe(1024);
  });

  it('caps the set at 10 files and 100MB in total', () => {
    const nine = Array.from({ length: 9 }, () => ({ size: MB }));
    expect(validateBroadcastAttachmentSet(nine, [{ size: MB }])).toBeNull();
    expect(validateBroadcastAttachmentSet(nine, [{ size: MB }, { size: MB }])).toMatch(/עד 10 קבצים/);
    expect(validateBroadcastAttachmentSet([{ size: 60 * MB }], [{ size: 40 * MB }])).toBeNull();
    expect(validateBroadcastAttachmentSet([{ size: 60 * MB }], [{ size: 40 * MB + 1 }])).toMatch(/חורג מ-100MB/);
    expect(validateBroadcastAttachmentSet([])).toBeNull();
  });
});
