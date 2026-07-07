// WhatsApp send provider — one interface, two implementations:
//   • real: Green API (mirrors src/lib/whatsapp.ts sendWhatsAppMessage; kept
//     self-contained so the standalone worker needs no Next 'server-only' deps)
//   • mock: no network — deterministic fake id, scriptable failures. Used by
//     dry_run campaigns and the whole test suite so NO real message is ever sent.

export interface SendInput {
  instanceId: string;
  token: string;
  apiUrl?: string;
  chatId: string;
  message: string;
}

export interface SendOk { ok: true; providerMessageId: string }
export interface SendErr { ok: false; status?: number; body?: string; message: string }
export type SendResult = SendOk | SendErr;

export interface WaProvider {
  readonly kind: 'real' | 'mock';
  send(input: SendInput): Promise<SendResult>;
}

// ── Real Green API provider ───────────────────────────────────────────────────
export class GreenApiProvider implements WaProvider {
  readonly kind = 'real' as const;
  async send(input: SendInput): Promise<SendResult> {
    const base = (input.apiUrl ?? 'https://api.green-api.com').replace(/\/+$/, '');
    const url = `${base}/waInstance${input.instanceId}/sendMessage/${input.token}`;
    let res: Response;
    let raw: string;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: input.chatId, message: input.message }),
      });
      raw = await res.text();
    } catch (err) {
      return { ok: false, message: `network: ${(err as Error).message}` };
    }
    if (!res.ok) return { ok: false, status: res.status, body: raw.slice(0, 300), message: `green api ${res.status}` };
    let idMessage: string | undefined;
    try { idMessage = (JSON.parse(raw) as { idMessage?: string }).idMessage; } catch { /* non-json */ }
    if (!idMessage) return { ok: false, status: res.status, body: raw.slice(0, 300), message: 'no idMessage in response' };
    return { ok: true, providerMessageId: idMessage };
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
}

export class MockProvider implements WaProvider {
  readonly kind = 'mock' as const;
  /** every send attempt, keyed by idempotency-ish chatId — tests assert exactly-once. */
  readonly sends: { chatId: string; message: string }[] = [];
  private readonly seen = new Map<string, number>();
  constructor(private readonly script: MockScript = {}) {}

  async send(input: SendInput): Promise<SendResult> {
    if (this.script.latencyMs) await new Promise((r) => setTimeout(r, this.script.latencyMs));
    this.sends.push({ chatId: input.chatId, message: input.message });

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

  /** how many times a given chatId was actually sent (for exactly-once asserts). */
  countFor(phoneIntl: string): number {
    return this.sends.filter((s) => s.chatId === `${phoneIntl}@c.us`).length;
  }
}

export function makeProvider(opts: { dryRun: boolean; script?: MockScript }): WaProvider {
  return opts.dryRun ? new MockProvider(opts.script) : new GreenApiProvider();
}
