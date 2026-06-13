import 'server-only';

/**
 * Cognito SRP authentication — a faithful port of amazon-cognito-identity-js.
 * Source: amplify-js / amazon-cognito-identity-js / AuthenticationHelper.js
 *
 * Ported 1:1 from the Base44 Deno function (importBuildingDebtReport/entry.ts)
 * to native Node 20+. In Node 20, crypto.subtle / crypto.getRandomValues /
 * atob / btoa / TextEncoder / BigInt are all available as globals — no node:*
 * imports are needed. Only the algorithm is ported here; the Bllink data fetch
 * lives in ./client.ts.
 */

const COGNITO_CLIENT_ID = '66iqqmjj6s81d6qu0pvqc4226l';
const COGNITO_REGION = 'us-east-1';
const COGNITO_POOL_ID = 'us-east-1_K0OcMyw20';
const POOL_NAME = COGNITO_POOL_ID.split('_')[1]; // "K0OcMyw20"
const COGNITO_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

// ── N (the large safe prime) and g, per RFC 5054 / amazon-cognito-identity-js ──
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const N = BigInt('0x' + N_HEX);
const g = BigInt(2);

// ── crypto helpers ─────────────────────────────────────────────────────────

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(buf);
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array | string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const sig = await crypto.subtle.sign('HMAC', key, bytes as BufferSource);
  return new Uint8Array(sig);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.length % 2 ? '0' + hex : hex;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * padHex — exactly as in amazon-cognito-identity-js.
 * Prepends 00 when the high bit is >= 0x80.
 */
function padHex(bignum: bigint): string {
  let hex = bignum.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  if ('89abcdef'.includes(hex[0])) hex = '00' + hex;
  return hex;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1);
  base = base % mod;
  while (exp > BigInt(0)) {
    if (exp % BigInt(2) === BigInt(1)) result = (result * base) % mod;
    exp = exp / BigInt(2);
    base = (base * base) % mod;
  }
  return result;
}

// ── k = H(N, g) ────────────────────────────────────────────────────────────
async function computeK(): Promise<bigint> {
  const nHex = N_HEX.length % 2 ? '0' + N_HEX : N_HEX;
  const gHex = '2'.padStart(nHex.length, '0');
  const hash = await sha256(concat(hexToBytes(nHex), hexToBytes(gHex)));
  return BigInt('0x' + bytesToHex(hash));
}

// ── u = H(A, B) ─────────────────────────────────────────────────────────────
async function computeU(A_hex: string, B_hex: string): Promise<bigint> {
  const pA = A_hex.length % 2 ? '0' + A_hex : A_hex;
  const pB = B_hex.length % 2 ? '0' + B_hex : B_hex;
  const hash = await sha256(concat(hexToBytes(pA), hexToBytes(pB)));
  return BigInt('0x' + bytesToHex(hash));
}

/**
 * x = H(salt || H(poolName || username || password))
 * Faithful to amazon-cognito-identity-js: no colons, direct string concat.
 */
async function computeX(saltHex: string, username: string, password: string): Promise<bigint> {
  const inner = await sha256(new TextEncoder().encode(POOL_NAME + username + password));
  const saltBytes = hexToBytes(saltHex.length % 2 ? '0' + saltHex : saltHex);
  const hash = await sha256(concat(saltBytes, inner));
  return BigInt('0x' + bytesToHex(hash));
}

/**
 * S = (B - k * g^x) ^ (a + u*x) mod N
 */
function computeS(a: bigint, B: bigint, k: bigint, u: bigint, x: bigint): bigint {
  let base = (B - k * modPow(g, x, N)) % N;
  if (base < BigInt(0)) base += N;
  const exp = a + u * x;
  return modPow(base, exp, N);
}

/**
 * HKDF key derivation — faithful to amazon-cognito-identity-js.
 * PRK = HMAC(key=H(A||B), data=S_bytes)
 * T   = HMAC(key=PRK, data="Caldera Derived Key" || 0x01)
 * return T[0:16]
 */
async function computeHkdfKey(A_hex: string, B_hex: string, S: bigint): Promise<Uint8Array> {
  const pA = A_hex.length % 2 ? '0' + A_hex : A_hex;
  const pB = B_hex.length % 2 ? '0' + B_hex : B_hex;
  const uHash = await sha256(concat(hexToBytes(pA), hexToBytes(pB)));
  const S_bytes = hexToBytes(padHex(S));
  const prk = await hmacSha256(uHash, S_bytes);
  const info = concat(new TextEncoder().encode('Caldera Derived Key'), new Uint8Array([0x01]));
  const T = await hmacSha256(prk, info);
  return T.slice(0, 16);
}

function cognitoTimestamp(): string {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const now = new Date();
  const d = String(now.getUTCDate()).padStart(2, ' ');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${d} ${hh}:${mm}:${ss} UTC ${now.getUTCFullYear()}`;
}

interface CognitoResponse {
  AuthenticationResult?: { AccessToken?: string };
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
}

async function cognitoPost(target: string, body: unknown): Promise<CognitoResponse> {
  const r = await fetch(COGNITO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Cognito ${target} נכשל: ${r.status} ${txt.slice(0, 400)}`);
  return JSON.parse(txt) as CognitoResponse;
}

/**
 * Authenticate against Cognito and return an AccessToken.
 * Tries USER_PASSWORD_AUTH first; on NotAuthorizedException /
 * ALLOW_USER_PASSWORD_AUTH falls back to the full USER_SRP_AUTH flow.
 */
export async function srpAuth(username: string, password: string): Promise<string> {
  // First attempt: USER_PASSWORD_AUTH (simpler, if the pool allows it).
  try {
    const resp = await cognitoPost('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
      ClientMetadata: {},
    });
    const token = resp?.AuthenticationResult?.AccessToken;
    if (token) return token;
    if (resp.ChallengeName) throw new Error(`Challenge נדרש: ${resp.ChallengeName}`);
    throw new Error(`USER_PASSWORD_AUTH לא החזיר token: ${JSON.stringify(resp).slice(0, 200)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('NotAuthorizedException') && !msg.includes('ALLOW_USER_PASSWORD_AUTH')) {
      throw e; // unrelated to the flow — propagate
    }
    // fallback: USER_SRP_AUTH
  }

  const k = await computeK();
  const aBytes = crypto.getRandomValues(new Uint8Array(128));
  const a = BigInt('0x' + bytesToHex(aBytes)) % N;
  const A = modPow(g, a, N);
  const A_hex = padHex(A);

  const init = await cognitoPost('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: username, SRP_A: A_hex },
    ClientMetadata: {},
  });

  if (init.ChallengeName !== 'PASSWORD_VERIFIER') {
    throw new Error(`Challenge לא צפוי: ${init.ChallengeName}`);
  }

  const cp = init.ChallengeParameters;
  if (!cp) throw new Error('PASSWORD_VERIFIER ללא ChallengeParameters');
  const { SRP_B, SALT, SECRET_BLOCK, USER_ID_FOR_SRP } = cp;
  const B = BigInt('0x' + SRP_B);
  const B_padHex = padHex(B);

  const u = await computeU(A_hex, B_padHex);
  const x = await computeX(SALT, USER_ID_FOR_SRP, password);
  const S = computeS(a, B, k, u, x);
  const hkdfKey = await computeHkdfKey(A_hex, B_padHex, S);
  const ts = cognitoTimestamp();

  const msg = concat(
    new TextEncoder().encode(POOL_NAME),
    new TextEncoder().encode(USER_ID_FOR_SRP),
    base64ToBytes(SECRET_BLOCK),
    new TextEncoder().encode(ts),
  );
  const sigBytes = await hmacSha256(hkdfKey, msg);
  const sig = bytesToBase64(sigBytes);

  const respond = await cognitoPost('RespondToAuthChallenge', {
    ChallengeName: 'PASSWORD_VERIFIER',
    ClientId: COGNITO_CLIENT_ID,
    ChallengeResponses: {
      USERNAME: USER_ID_FOR_SRP,
      PASSWORD_CLAIM_SECRET_BLOCK: SECRET_BLOCK,
      TIMESTAMP: ts,
      PASSWORD_CLAIM_SIGNATURE: sig,
    },
    ClientMetadata: {},
  });

  if (respond.ChallengeName) throw new Error(`אתגר נוסף: ${respond.ChallengeName}`);

  const token = respond?.AuthenticationResult?.AccessToken;
  if (!token) throw new Error(`לא התקבל AccessToken: ${JSON.stringify(respond).slice(0, 300)}`);
  return token;
}
