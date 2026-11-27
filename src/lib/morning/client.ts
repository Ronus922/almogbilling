import 'server-only';
import { env } from '@/env';

// Morning (formerly Green Invoice) — the invoicing service of the BUILDING's
// account. Our code issues the documents of chip orders through its public API
// (26/11/2026); PayPlus issues none (initial_invoice: false).
//
// Everything here follows the current official documentation —
// developers.morning.co (OpenAPI "morning API Documentation" 2.0.0, read
// 25/11/2026; www.greeninvoice.co.il/api-docs redirects there):
//   - the token: POST {idp}/idp/v1/oauth/token, JSON {grant_type:
//     "client_credentials", client_id, client_secret} → {accessToken,
//     tokenType: "Bearer", expiresAt (unix seconds)}, valid one hour;
//   - every other call: {api}/…, "Authorization: Bearer <accessToken>";
//   - POST /documents (CreateDocumentRequest) → {id, number, url{origin, he, en}};
//   - POST /documents/search (SearchDocumentsRequest);
//   - GET /documents/info?type= (DocumentInfo: exemption, vatRate, …).
// GET /businesses/me (the business type) is in the previous documentation
// only; it is tried first, and its absence (404) or refusal (403) is
// tolerated — the exemption then comes from documents/info.
//
// THE KEY IS SERVER-ONLY: read here, sent in the token request's body, never in
// a URL, a log line, an error message or a response to a browser.

export type MorningMode = 'production' | 'sandbox';

const HOSTS: Record<MorningMode, { token: string; api: string }> = {
  production: { token: 'https://api.morning.co/idp/v1/oauth/token', api: 'https://api.greeninvoice.co.il/api/v1' },
  sandbox: { token: 'https://api.sandbox.morning.dev/idp/v1/oauth/token', api: 'https://sandbox.d.greeninvoice.co.il/api/v1' },
};
const TIMEOUT_MS = 20_000;

export interface MorningConfig {
  mode: MorningMode;
  tokenUrl: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
}

/** The configuration, or null while the key id or secret is missing. */
export function morningConfig(): MorningConfig | null {
  const clientId = env.MORNING_API_KEY_ID;
  const clientSecret = env.MORNING_API_KEY_SECRET;
  if (!clientId || !clientSecret) return null;
  const mode: MorningMode = env.MORNING_ENV === 'sandbox' ? 'sandbox' : 'production';
  return { mode, tokenUrl: HOSTS[mode].token, apiBase: HOSTS[mode].api, clientId, clientSecret };
}

export class MorningApiError extends Error {
  constructor(
    readonly endpoint: string,
    /** HTTP status; 0 = no reply (network, timeout). */
    readonly status: number,
    /** Morning's own errorCode (or the OAuth error), when it sent one. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'MorningApiError';
  }

  /** Worth trying again later: no reply, a throttle, a server error. A refusal
   *  of the request itself (validation, a document type the business may not
   *  issue, a missing subscription) is not — it needs a person. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** The key itself was refused (wrong, revoked, no API subscription). */
  get authProblem(): boolean {
    return this.status === 401 || this.status === 403 || (this.endpoint === 'token' && this.status >= 400 && this.status < 500);
  }
}

function safeText(cfg: MorningConfig, text: string): string {
  let out = text;
  for (const secret of [cfg.clientId, cfg.clientSecret]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 300);
}

let tokenCache: { clientId: string; mode: MorningMode; token: string; expiresAtMs: number } | null = null;

/** Tests only: forget the cached token. */
export function __resetMorningTokenForTests(): void {
  tokenCache = null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { __text: text.slice(0, 300) };
  }
}

function errorOf(cfg: MorningConfig, endpoint: string, status: number, json: unknown): MorningApiError {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const code = typeof j.errorCode === 'number' || typeof j.errorCode === 'string' ? String(j.errorCode)
    : typeof j.error === 'string' ? j.error : null;
  const said = typeof j.errorMessage === 'string' ? j.errorMessage
    : typeof j.error_description === 'string' ? j.error_description
      : typeof j.message === 'string' ? j.message
        : typeof j.__text === 'string' ? j.__text : `HTTP ${status}`;
  return new MorningApiError(endpoint, status, code, safeText(cfg, said));
}

async function getToken(cfg: MorningConfig, force = false): Promise<string> {
  const now = Date.now();
  if (!force && tokenCache && tokenCache.clientId === cfg.clientId && tokenCache.mode === cfg.mode && tokenCache.expiresAtMs - 120_000 > now) {
    return tokenCache.token;
  }
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    throw new MorningApiError('token', 0, null, `no reply from Morning (${(e as Error).name})`);
  }
  const json = await readJson(res);
  if (!res.ok) throw errorOf(cfg, 'token', res.status, json);
  const j = (json ?? {}) as { accessToken?: unknown; expiresAt?: unknown };
  if (typeof j.accessToken !== 'string' || !j.accessToken) throw new MorningApiError('token', res.status, null, 'the token reply carries no accessToken');
  const expiresAtMs = typeof j.expiresAt === 'number' && Number.isFinite(j.expiresAt) ? j.expiresAt * 1000 : now + 50 * 60_000;
  tokenCache = { clientId: cfg.clientId, mode: cfg.mode, token: j.accessToken, expiresAtMs };
  return j.accessToken;
}

/** One API call. A 401 re-authenticates once (the token may have expired early). */
async function call(cfg: MorningConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const endpoint = path.split('?')[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(cfg, attempt > 0);
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBase}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (e) {
      throw new MorningApiError(endpoint, 0, null, `no reply from Morning (${(e as Error).name})`);
    }
    const json = await readJson(res);
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw errorOf(cfg, endpoint, res.status, json);
    return json;
  }
  throw new MorningApiError(endpoint, 401, null, 'unauthorized');
}

// ── The business ────────────────────────────────────────────────────────────

/** BusinessType of the documentation: 1 עוסק מורשה, 2 חברה בע״מ, 3 עוסק פטור,
 *  4 עמותה, 5 חברה לתועלת הציבור, 6 שותפות. */
export interface MorningBusinessProfile {
  /** null when the account did not say. */
  businessType: number | null;
  /** The business is VAT-exempt (documents/info.exemption or the business). */
  exemption: boolean | null;
  /** The VAT rate a new document gets (e.g. 0.18), when Morning said. */
  vatRate: number | null;
  /** Document types the account lists as available, when it said. */
  availableTypes: number[] | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Reads what the account says about itself. Every part is best-effort: a part
 *  Morning does not answer stays null (the caller decides nothing on a null).
 *  /businesses/me is in the previous documentation only: a 404 — or a 403, the
 *  endpoint refusing a key the token endpoint accepted — leaves the business
 *  type unknown, and the exemption is read from documents/info. The key itself
 *  refused (the token request, or a 401 even with a fresh token), or a 403
 *  from documents/info as well, is an error of the account: thrown. */
export async function readBusinessProfile(cfg: MorningConfig): Promise<MorningBusinessProfile> {
  const out: MorningBusinessProfile = { businessType: null, exemption: null, vatRate: null, availableTypes: null };
  let meForbidden: MorningApiError | null = null;
  try {
    const me = (await call(cfg, 'GET', '/businesses/me')) as Record<string, unknown> | null;
    out.businessType = num(me?.type);
    if (typeof me?.exemption === 'boolean') out.exemption = me.exemption;
  } catch (e) {
    if (e instanceof MorningApiError && e.authProblem) {
      if (e.endpoint === 'token' || e.status !== 403) throw e;
      meForbidden = e;
    }
  }
  try {
    const info = (await call(cfg, 'GET', '/documents/info?type=320')) as Record<string, unknown> | null;
    if (typeof info?.exemption === 'boolean') out.exemption = info.exemption;
    out.vatRate = num(info?.vatRate);
  } catch (e) {
    // An account that may not issue 320 can answer with an error here. Refused
    // here as well as on /businesses/me: the account refuses this key.
    if (meForbidden && e instanceof MorningApiError && e.authProblem) throw meForbidden;
  }
  try {
    const types = (await call(cfg, 'GET', '/documents/types?lang=he')) as unknown;
    if (Array.isArray(types)) {
      const ids = types.map((t) => num((t as { id?: unknown })?.id)).filter((n): n is number => n !== null);
      if (ids.length > 0) out.availableTypes = ids;
    }
  } catch {
    // Optional.
  }
  return out;
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface MorningIssued {
  type: number;
  id: string;
  number: string;
  /** The original document's link (url.origin), or the Hebrew copy. */
  url: string | null;
}

/** POST /documents — the body is built by src/lib/morning/documents.ts. */
export async function createDocument(cfg: MorningConfig, body: Record<string, unknown>): Promise<MorningIssued> {
  const json = (await call(cfg, 'POST', '/documents', body)) as Record<string, unknown> | null;
  const id = typeof json?.id === 'string' ? json.id : null;
  const number = num(json?.number);
  if (!id || number === null) throw new MorningApiError('/documents', 200, null, 'the reply carries no document id / number');
  const url = (json?.url ?? {}) as { origin?: unknown; he?: unknown };
  return {
    type: num(json?.type) ?? num(body.type) ?? 0,
    id,
    number: String(number),
    url: typeof url.origin === 'string' ? url.origin : typeof url.he === 'string' ? url.he : null,
  };
}

export interface MorningSearchItem {
  id: string;
  number: string;
  type: number | null;
  remarks: string;
  description: string;
  amount: number | null;
  url: string | null;
}

/** POST /documents/search — documents of these types issued between two
 *  dates (Morning's date, YYYY-MM-DD). Used only to find a document a crash
 *  may have left unrecorded (its `ref` is in the remarks). */
export async function searchDocuments(
  cfg: MorningConfig,
  filter: { types: number[]; fromDate: string; toDate: string; clientName?: string },
): Promise<MorningSearchItem[]> {
  const json = (await call(cfg, 'POST', '/documents/search', {
    type: filter.types,
    fromDate: filter.fromDate,
    toDate: filter.toDate,
    ...(filter.clientName ? { clientName: filter.clientName } : {}),
    page: 1,
    pageSize: 100,
  })) as { items?: unknown } | null;
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const url = (it.url ?? {}) as { origin?: unknown; he?: unknown };
    return {
      id: typeof it.id === 'string' ? it.id : '',
      number: it.number === undefined || it.number === null ? '' : String(it.number),
      type: num(it.type),
      remarks: typeof it.remarks === 'string' ? it.remarks : '',
      description: typeof it.description === 'string' ? it.description : '',
      amount: num(it.amount),
      url: typeof url.origin === 'string' ? url.origin : typeof url.he === 'string' ? url.he : null,
    };
  }).filter((it) => it.id);
}
