// WhatsApp send provider — one interface, two implementations:
//   • real: Green API (mirrors src/lib/whatsapp.ts sendWhatsAppMessage /
//     sendWhatsAppFileByUrl; kept self-contained so the standalone worker needs
//     no Next 'server-only' deps)
//   • mock: no network — deterministic fake id, scriptable failures. Used by
//     dry_run campaigns and the whole test suite so NO real message is ever sent.
//
// File methods (broadcast attachments, green-api.com docs 14/09/2026):
//   sendFileByUrl    JSON  {chatId, urlFile, fileName, caption?}   → {{apiUrl}}
//   uploadFile       raw bytes + Content-Type (+ GA-Filename)      → {{mediaUrl}}  → {urlFile}, valid 15 days
//   sendFileByUpload multipart {chatId, file, fileName, caption?}  → {{mediaUrl}}  → {idMessage}
// mediaUrl is the instance's media host: api.green-api.com → media.green-api.com,
// 7103.api.greenapi.com → 7103.media.greenapi.com (see mediaBaseFor).

export interface SendInput {
  instanceId: string;
  token: string;
  apiUrl?: string;
  chatId: string;
  message: string;
}

export interface FileByUrlInput {
  instanceId: string;
  token: string;
  apiUrl?: string;
  chatId: string;
  /** The Green API cloud link (from uploadFile) or any direct file URL. */
  urlFile: string;
  /** Name shown to the recipient — must carry the extension. */
  fileName: string;
  caption?: string;
}

export interface UploadFileInput {
  instanceId: string;
  token: string;
  apiUrl?: string;
  bytes: Buffer;
  mimeType: string;
  /** ASCII name with extension for the GA-Filename header (the object key leaf). */
  fileName: string;
}

export interface FileByUploadInput extends UploadFileInput {
  chatId: string;
  /** Name shown to the recipient (UTF-8 ok — it travels as a form field). */
  displayName: string;
  caption?: string;
}

export interface SendOk { ok: true; providerMessageId: string }
export interface SendErr { ok: false; status?: number; body?: string; message: string }
export type SendResult = SendOk | SendErr;
export interface UploadOk { ok: true; urlFile: string }
export type UploadResult = UploadOk | SendErr;

export interface WaProvider {
  readonly kind: 'real' | 'mock';
  send(input: SendInput): Promise<SendResult>;
  sendFileByUrl(input: FileByUrlInput): Promise<SendResult>;
  uploadFile(input: UploadFileInput): Promise<UploadResult>;
  sendFileByUpload(input: FileByUploadInput): Promise<SendResult>;
}

const DEFAULT_API = 'https://api.green-api.com';
const DEFAULT_MEDIA = 'https://media.green-api.com';
/** Network budget: a text/URL send is quick; an upload carries up to 50 MB. */
const SEND_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export function apiBaseFor(apiUrl?: string | null): string {
  const v = (apiUrl ?? '').trim().replace(/\/+$/, '');
  return v || DEFAULT_API;
}

/** The media host that pairs with an API host (Green API "using hosts" page):
 *  the `api.` label becomes `media.`; unknown shapes fall back to the universal
 *  media host. */
export function mediaBaseFor(apiUrl?: string | null): string {
  const base = apiBaseFor(apiUrl);
  const swapped = base.replace(/(\/\/|\.)api\./i, '$1media.');
  return swapped !== base ? swapped : DEFAULT_MEDIA;
}

// ── Real Green API provider ───────────────────────────────────────────────────
type Raw = { res: Response; raw: string } | { err: string };

async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Raw> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { res, raw: await res.text() };
  } catch (err) {
    return { err: `network: ${(err as Error).message}` };
  }
}

function parseField(r: Raw, field: 'idMessage' | 'urlFile'): { ok: true; value: string } | SendErr {
  if ('err' in r) return { ok: false, message: r.err };
  if (!r.res.ok) return { ok: false, status: r.res.status, body: r.raw.slice(0, 300), message: `green api ${r.res.status}` };
  let value: string | undefined;
  try { value = (JSON.parse(r.raw) as Record<string, unknown>)[field] as string | undefined; } catch { /* non-json */ }
  if (typeof value !== 'string' || !value) {
    return { ok: false, status: r.res.status, body: r.raw.slice(0, 300), message: `no ${field} in response` };
  }
  return { ok: true, value };
}

function asSend(p: { ok: true; value: string } | SendErr): SendResult {
  return p.ok ? { ok: true, providerMessageId: p.value } : p;
}

export class GreenApiProvider implements WaProvider {
  readonly kind = 'real' as const;

  async send(input: SendInput): Promise<SendResult> {
    const url = `${apiBaseFor(input.apiUrl)}/waInstance${input.instanceId}/sendMessage/${input.token}`;
    const r = await call(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: input.chatId, message: input.message }),
    }, SEND_TIMEOUT_MS);
    return asSend(parseField(r, 'idMessage'));
  }

  async sendFileByUrl(input: FileByUrlInput): Promise<SendResult> {
    const url = `${apiBaseFor(input.apiUrl)}/waInstance${input.instanceId}/sendFileByUrl/${input.token}`;
    const r = await call(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: input.chatId,
        urlFile: input.urlFile,
        fileName: input.fileName,
        ...(input.caption ? { caption: input.caption } : {}),
      }),
    }, SEND_TIMEOUT_MS);
    return asSend(parseField(r, 'idMessage'));
  }

  async uploadFile(input: UploadFileInput): Promise<UploadResult> {
    const url = `${mediaBaseFor(input.apiUrl)}/waInstance${input.instanceId}/uploadFile/${input.token}`;
    const r = await call(url, {
      method: 'POST',
      headers: { 'Content-Type': input.mimeType, 'GA-Filename': input.fileName },
      body: new Uint8Array(input.bytes),
    }, UPLOAD_TIMEOUT_MS);
    const p = parseField(r, 'urlFile');
    return p.ok ? { ok: true, urlFile: p.value } : p;
  }

  async sendFileByUpload(input: FileByUploadInput): Promise<SendResult> {
    const url = `${mediaBaseFor(input.apiUrl)}/waInstance${input.instanceId}/sendFileByUpload/${input.token}`;
    const form = new FormData();
    form.append('chatId', input.chatId);
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName);
    form.append('fileName', input.displayName);
    if (input.caption) form.append('caption', input.caption);
    const r = await call(url, { method: 'POST', body: form }, UPLOAD_TIMEOUT_MS);
    return asSend(parseField(r, 'idMessage'));
  }
}

// ── Mock provider (dry-run / tests) ───────────────────────────────────────────
export interface MockScript {
  /** phone_intl → forced outcome, for exercising retry/permanent paths in tests. */
  fail?: Record<string, { status?: number; body?: string; message: string }>;
  /** phones that fail the given number of times then succeed (transient). */
  failTimes?: Record<string, number>;
  /** ms of simulated latency (lets tests kill the worker mid-send). */
  latencyMs?: number;
  /** Force uploadFile to fail (exercises the sendFileByUpload fallback). */
  failUpload?: boolean;
  /** fileName → forced failure of that file's send (by URL or by upload). */
  failFile?: Record<string, { status?: number; body?: string; message: string }>;
}

export interface MockSend {
  chatId: string;
  /** Text message, or the caption of a file send ('' when none). */
  message: string;
  kind: 'text' | 'file_url' | 'file_upload';
  fileName?: string;
}

export class MockProvider implements WaProvider {
  readonly kind = 'mock' as const;
  /** every send attempt, keyed by idempotency-ish chatId — tests assert exactly-once. */
  readonly sends: MockSend[] = [];
  /** every uploadFile call (fileName), for once-per-campaign asserts. */
  readonly uploads: string[] = [];
  private readonly seen = new Map<string, number>();
  constructor(private readonly script: MockScript = {}) {}

  async send(input: SendInput): Promise<SendResult> {
    if (this.script.latencyMs) await new Promise((r) => setTimeout(r, this.script.latencyMs));
    this.sends.push({ chatId: input.chatId, message: input.message, kind: 'text' });

    const times = this.script.failTimes?.[input.chatId.replace('@c.us', '')];
    if (times !== undefined) {
      const n = (this.seen.get(input.chatId) ?? 0) + 1;
      this.seen.set(input.chatId, n);
      if (n <= times) return { ok: false, message: `mock transient ${n}/${times}` };
    }
    const forced = this.script.fail?.[input.chatId.replace('@c.us', '')];
    if (forced) return { ok: false, ...forced };

    return { ok: true, providerMessageId: `mock-${input.chatId}-${this.sends.length}` };
  }

  private fileResult(chatId: string, fileName: string): SendResult {
    const forced = this.script.failFile?.[fileName];
    if (forced) return { ok: false, ...forced };
    return { ok: true, providerMessageId: `mock-${chatId}-${this.sends.length}` };
  }

  async sendFileByUrl(input: FileByUrlInput): Promise<SendResult> {
    this.sends.push({ chatId: input.chatId, message: input.caption ?? '', kind: 'file_url', fileName: input.fileName });
    return this.fileResult(input.chatId, input.fileName);
  }

  async uploadFile(input: UploadFileInput): Promise<UploadResult> {
    this.uploads.push(input.fileName);
    if (this.script.failUpload) return { ok: false, message: 'mock upload failed' };
    return { ok: true, urlFile: `mock://green/${input.fileName}` };
  }

  async sendFileByUpload(input: FileByUploadInput): Promise<SendResult> {
    this.sends.push({ chatId: input.chatId, message: input.caption ?? '', kind: 'file_upload', fileName: input.displayName });
    return this.fileResult(input.chatId, input.displayName);
  }

  /** how many times a given chatId was actually sent (for exactly-once asserts). */
  countFor(phoneIntl: string): number {
    return this.sends.filter((s) => s.chatId === `${phoneIntl}@c.us`).length;
  }
}

export function makeProvider(opts: { dryRun: boolean; script?: MockScript }): WaProvider {
  return opts.dryRun ? new MockProvider(opts.script) : new GreenApiProvider();
}
