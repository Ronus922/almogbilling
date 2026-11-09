import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// Two in-process stand-ins for the services the visitor-scan screen talks to,
// started by e2e/visitors.spec.ts for the length of that spec ONLY (so no other
// spec sees them):
//
//   • the Anthropic Messages API (the OCR). The app's server is started by
//     playwright.config.ts with ANTHROPIC_BASE_URL pointing here; the SDK honours
//     that variable, so no production code carries a test switch.
//   • Supabase Storage (bucket create / upload / download / remove) on the port
//     NEXT_PUBLIC_SUPABASE_URL already names in CI (54321). Nothing in CI runs a
//     Storage service, so the photo's round trip is proved against this stand-in.
//
// Everything the app sent is recorded, so the spec can assert on what actually
// left the server: the OCR request carried a JPEG of at most 1600px, a stored
// object is a JPEG with no EXIF, and a delete really asks Storage to remove it.

export type OcrMode = 'ok' | 'error' | 'garbage';

export interface OcrCall {
  model: string;
  mediaType: string;
  imageBytes: Buffer;
  system: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

export class AnthropicStub {
  mode: OcrMode = 'ok';
  /** What the model "reads" off the document. */
  reply: Record<string, unknown> = {};
  calls: OcrCall[] = [];
  private server: Server | null = null;

  async start(port: number): Promise<void> {
    this.server = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) return send(res, 404, { error: 'not_found' });
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8')) as {
        model: string;
        system: string;
        messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[];
      };
      const img = body.messages[0]?.content.find((b) => b.type === 'image');
      this.calls.push({
        model: body.model,
        mediaType: img?.source?.media_type ?? '',
        imageBytes: Buffer.from(img?.source?.data ?? '', 'base64'),
        system: body.system,
      });
      if (this.mode === 'error') {
        return send(res, 500, { type: 'error', error: { type: 'api_error', message: 'stub failure' } });
      }
      const text = this.mode === 'garbage' ? 'Sorry, I cannot read this document.' : JSON.stringify(this.reply);
      return send(res, 200, {
        id: 'msg_stub', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    await listen(this.server, port);
  }

  reset(): void {
    this.mode = 'ok';
    this.calls = [];
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

export interface StoredObject {
  contentType: string;
  bytes: Buffer;
}

export class StorageStub {
  readonly objects = new Map<string, StoredObject>();
  readonly buckets = new Set<string>();
  readonly removed: string[] = [];
  /** When true, bulk removal answers 500 — Storage that refuses to drop the photo. */
  failRemove = false;
  private server: Server | null = null;

  async start(port: number): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const parts = url.pathname.split('/').filter(Boolean); // storage v1 object <bucket> <path…>
      if (parts[0] !== 'storage' || parts[1] !== 'v1') return send(res, 404, { error: 'not_found' });
      const route = parts[2];

      if (route === 'bucket' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString('utf8')) as { id?: string; name?: string };
        const id = b.id ?? b.name ?? '';
        if (this.buckets.has(id)) return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        this.buckets.add(id);
        return send(res, 200, { name: id });
      }

      if (route === 'object') {
        // Bulk remove: DELETE /object/<bucket>  { prefixes: [...] }
        if (req.method === 'DELETE' && parts.length === 4) {
          if (this.failRemove) return send(res, 500, { statusCode: '500', error: 'Internal', message: 'stub: removal refused' });
          const bucket = parts[3]!;
          const { prefixes } = JSON.parse((await readBody(req)).toString('utf8')) as { prefixes: string[] };
          for (const p of prefixes) {
            this.objects.delete(`${bucket}/${p}`);
            this.removed.push(`${bucket}/${p}`);
          }
          return send(res, 200, prefixes.map((name) => ({ name })));
        }
        const authenticated = parts[3] === 'authenticated';
        const bucket = authenticated ? parts[4]! : parts[3]!;
        const key = (authenticated ? parts.slice(5) : parts.slice(4)).map(decodeURIComponent).join('/');
        const id = `${bucket}/${key}`;
        if (req.method === 'POST') {
          const bytes = await readBody(req);
          if (this.objects.has(id) && req.headers['x-upsert'] !== 'true') {
            return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
          }
          this.objects.set(id, { contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), bytes });
          return send(res, 200, { Id: id, Key: id });
        }
        if (req.method === 'GET') {
          const o = this.objects.get(id);
          if (!o) return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
          res.writeHead(200, { 'content-type': o.contentType, 'content-length': String(o.bytes.length) });
          return void res.end(o.bytes);
        }
      }
      return send(res, 404, { error: 'not_found' });
    });
    await listen(this.server, port);
  }

  /** Object ids (`bucket/key`) currently stored in one bucket. */
  keys(bucket: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/`));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
