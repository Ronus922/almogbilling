import { describe, expect, it } from 'vitest';
import { planSteps, wireFileName, asciiLeaf, hasUsableUrl } from '@/lib/wa-queue/attachments';
import { mediaBaseFor, apiBaseFor, MockProvider } from '@/lib/wa-queue/provider';

// Pure pieces of the attachment send path: what a recipient still needs to get
// (and in which order), how a retry resumes, and the Green API host mapping.
// The DB-backed engine is covered by tests/wa-queue.test.ts (needs a test DB).

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
const fresh = { payload: 'שלום', provider_message_id: null, attachments_sent: 0 };

describe('planSteps — text first, then files in order', () => {
  it('text-only broadcast: one text step, none once sent', () => {
    expect(planSteps(fresh, [])).toEqual([{ kind: 'text' }]);
    expect(planSteps({ ...fresh, provider_message_id: 'm1' }, [])).toEqual([]);
  });

  it('several files: text, then every file', () => {
    expect(planSteps(fresh, files(3))).toEqual([
      { kind: 'text' }, { kind: 'file', index: 0 }, { kind: 'file', index: 1 }, { kind: 'file', index: 2 },
    ]);
  });

  it('exactly one file: the text rides as its caption (no separate message)', () => {
    expect(planSteps(fresh, files(1))).toEqual([{ kind: 'file', index: 0, caption: 'שלום' }]);
  });

  it('one file but a caption too long for WhatsApp: text and file separately', () => {
    const long = { ...fresh, payload: 'x'.repeat(1025) };
    expect(planSteps(long, files(1))).toEqual([{ kind: 'text' }, { kind: 'file', index: 0 }]);
    expect(planSteps({ ...fresh, payload: 'x'.repeat(1024) }, files(1))).toEqual([{ kind: 'file', index: 0, caption: 'x'.repeat(1024) }]);
  });

  it('retry resumes after the parts already delivered — never a duplicate', () => {
    // text went out, first file went out, second failed
    expect(planSteps({ ...fresh, provider_message_id: 'm1', attachments_sent: 1 }, files(3))).toEqual([
      { kind: 'file', index: 1 }, { kind: 'file', index: 2 },
    ]);
    // captioned single file already sent
    expect(planSteps({ ...fresh, provider_message_id: 'm1', attachments_sent: 1 }, files(1))).toEqual([]);
    // text sent, no file yet
    expect(planSteps({ ...fresh, provider_message_id: 'm1' }, files(2))).toEqual([
      { kind: 'file', index: 0 }, { kind: 'file', index: 1 },
    ]);
    // everything delivered
    expect(planSteps({ ...fresh, provider_message_id: 'm1', attachments_sent: 3 }, files(3))).toEqual([]);
  });
});

describe('file naming for Green API', () => {
  it('keeps the Hebrew name and extension; webp is declared as png (Green FAQ workaround)', () => {
    expect(wireFileName('דוח חודשי.pdf')).toBe('דוח חודשי.pdf');
    expect(wireFileName('תמונה.webp')).toBe('תמונה.png');
    expect(wireFileName('photo.WEBP')).toBe('photo.png');
  });

  it('asciiLeaf returns the key leaf (the uuid.ext the storage knows)', () => {
    expect(asciiLeaf('3f2a1c4e-0000-4000-8000-000000000000.pdf')).toBe('3f2a1c4e-0000-4000-8000-000000000000.pdf');
    expect(asciiLeaf('prefix/abc.png')).toBe('abc.png');
  });

  it('hasUsableUrl requires a link that has not expired', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    expect(hasUsableUrl({ green_api_url: null, green_api_url_expires_at: null }, now)).toBe(false);
    expect(hasUsableUrl({ green_api_url: 'https://x/f.pdf', green_api_url_expires_at: null }, now)).toBe(true);
    expect(hasUsableUrl({ green_api_url: 'https://x/f.pdf', green_api_url_expires_at: '2026-09-20T00:00:00Z' }, now)).toBe(true);
    expect(hasUsableUrl({ green_api_url: 'https://x/f.pdf', green_api_url_expires_at: '2026-09-14T11:59:59Z' }, now)).toBe(false);
  });
});

describe('Green API hosts', () => {
  it('maps the api host to its media host, with the universal fallback', () => {
    expect(apiBaseFor(undefined)).toBe('https://api.green-api.com');
    expect(apiBaseFor('https://api.green-api.com/')).toBe('https://api.green-api.com');
    expect(mediaBaseFor('https://api.green-api.com')).toBe('https://media.green-api.com');
    expect(mediaBaseFor('https://api.greenapi.com')).toBe('https://media.greenapi.com');
    expect(mediaBaseFor('https://7103.api.greenapi.com')).toBe('https://7103.media.greenapi.com');
    expect(mediaBaseFor('https://custom.example.com')).toBe('https://media.green-api.com');
    expect(mediaBaseFor(undefined)).toBe('https://media.green-api.com');
  });
});

describe('MockProvider file methods', () => {
  it('records uploads and file sends separately from text sends', async () => {
    const mock = new MockProvider();
    const up = await mock.uploadFile({ instanceId: 'i', token: 't', bytes: Buffer.alloc(0), mimeType: 'application/pdf', fileName: 'a.pdf' });
    expect(up.ok && up.urlFile.startsWith('mock://')).toBe(true);
    await mock.send({ instanceId: 'i', token: 't', chatId: '972500000001@c.us', message: 'hi' });
    await mock.sendFileByUrl({ instanceId: 'i', token: 't', chatId: '972500000001@c.us', urlFile: 'mock://x', fileName: 'דוח.pdf' });
    expect(mock.uploads).toEqual(['a.pdf']);
    expect(mock.sends.map((s) => s.kind)).toEqual(['text', 'file_url']);
    expect(mock.countFor('972500000001')).toBe(2);
  });

  it('scripted upload failure and per-file failure', async () => {
    const mock = new MockProvider({ failUpload: true, failFile: { 'bad.pdf': { status: 400, message: 'bad file' } } });
    const up = await mock.uploadFile({ instanceId: 'i', token: 't', bytes: Buffer.alloc(0), mimeType: 'application/pdf', fileName: 'a.pdf' });
    expect(up.ok).toBe(false);
    const bad = await mock.sendFileByUpload({ instanceId: 'i', token: 't', chatId: 'c@c.us', bytes: Buffer.alloc(1), mimeType: 'application/pdf', fileName: 'x.pdf', displayName: 'bad.pdf' });
    expect(bad.ok).toBe(false);
    const good = await mock.sendFileByUpload({ instanceId: 'i', token: 't', chatId: 'c@c.us', bytes: Buffer.alloc(1), mimeType: 'application/pdf', fileName: 'x.pdf', displayName: 'good.pdf' });
    expect(good.ok).toBe(true);
  });
});
