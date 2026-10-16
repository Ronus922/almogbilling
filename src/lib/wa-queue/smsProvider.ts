import {
  SMS_019_SEND_URL, buildProvider019RequestBody, describeProvider019Status, parseProvider019Response,
} from '@/lib/sms019';
import type { SendResult } from './provider';

// 019sms send, for the broadcast SMS channel. Self-contained like
// wa-queue/provider.ts is for Green API: the standalone worker needs no Next
// 'server-only' deps, so credentials are explicit input fields, never read
// from @/env inside here (the worker resolves them once per tick — see
// smsCredsFor in worker.ts). Request/response shape shared with the portal
// OTP adapter via src/lib/sms019.ts.

export interface SmsSendInput {
  username: string;
  token: string;
  source: string;
  /** 019's expected shape: '5XXXXXXXX' or '05XXXXXXXX'. */
  localPhone: string;
  message: string;
}

export interface SmsProvider {
  readonly kind: 'real' | 'mock';
  send(input: SmsSendInput): Promise<SendResult>;
}

/** Bounded so a stuck connection cannot pin a recipient's lease forever. */
const SEND_TIMEOUT_MS = 10_000;

export class Provider019 implements SmsProvider {
  readonly kind = 'real' as const;

  async send(input: SmsSendInput): Promise<SendResult> {
    const body = buildProvider019RequestBody({
      username: input.username, source: input.source, localPhone: input.localPhone, message: input.message,
    });

    let res: Response;
    let raw: string;
    try {
      res = await fetch(SMS_019_SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      raw = await res.text();
    } catch (err) {
      return { ok: false, message: `019sms לא הגיב: ${(err as Error).message}` };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, body: raw.slice(0, 300), message: `019sms HTTP ${res.status}` };
    }

    const parsed = parseProvider019Response(raw);
    if (!parsed) {
      return { ok: false, body: raw.slice(0, 300), message: '019sms תשובה לא צפויה' };
    }
    if (parsed.status !== 0) {
      return {
        ok: false,
        status: parsed.status,
        body: raw.slice(0, 300),
        message: describeProvider019Status(parsed.status, parsed.message),
      };
    }
    return { ok: true, providerMessageId: parsed.shipment_id ?? '' };
  }
}

// ── Mock provider (dry-run / tests) ───────────────────────────────────────────

export interface MockSmsScript {
  /** localPhone → forced outcome, for exercising the retry/fallback paths in tests. */
  fail?: Record<string, { status?: number; message: string }>;
}

export class MockSmsProvider implements SmsProvider {
  readonly kind = 'mock' as const;
  readonly sends: { localPhone: string; message: string }[] = [];
  constructor(private readonly script: MockSmsScript = {}) {}

  async send(input: SmsSendInput): Promise<SendResult> {
    this.sends.push({ localPhone: input.localPhone, message: input.message });
    const forced = this.script.fail?.[input.localPhone];
    if (forced) return { ok: false, ...forced };
    return { ok: true, providerMessageId: `mock-sms-${this.sends.length}` };
  }
}

export function makeSmsProvider(opts: { dryRun: boolean; script?: MockSmsScript }): SmsProvider {
  return opts.dryRun ? new MockSmsProvider(opts.script) : new Provider019();
}
