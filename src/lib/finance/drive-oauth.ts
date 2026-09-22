import 'server-only';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { AuthorizationError } from '@/lib/auth/errors';
import { hasPermission } from '@/lib/permissions/check';

/**
 * OAuth for the Drive backup — the SAME Google OAuth client AND the same
 * redirect URI as the team login (/api/auth/google/callback), so nothing has
 * to be registered in GCP beyond what the login already needs. The login
 * callback tells the two flows apart by the `state` parameter: a Drive state
 * is an AES-256-GCM blob sealed with SETTINGS_ENC_KEY (settings-cipher) that
 * carries the flow marker, a nonce (echoed in an httpOnly cookie), the admin's
 * user id and an expiry. A login state is 16 random bytes and can never open
 * as a Drive state, so the login path runs unchanged for everything else.
 */

/** drive.file = only files this app created; openid+email = to verify WHICH
 *  account was connected (only FINANCE_DRIVE_ACCOUNT is accepted). */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'] as const;

export const DRIVE_FLOW = 'finance_drive';
/** How long a started connection stays valid (state expiry + cookie max-age). */
export const DRIVE_STATE_TTL_SEC = 600;
export const DRIVE_NONCE_COOKIE = 'fin_drive_nonce';
export const DRIVE_VERIFIER_COOKIE = 'fin_drive_verifier';

export interface DriveOAuthState {
  flow: typeof DRIVE_FLOW;
  /** Random per attempt; must equal the DRIVE_NONCE_COOKIE value on return. */
  nonce: string;
  /** The admin who pressed "חבר Google Drive" — must equal the session user on return. */
  uid: string;
  /** Unix ms. */
  exp: number;
}

const MAX_STATE_CHARS = 2048;
// The blob comes from an unauthenticated query string: insist on the full
// 128-bit GCM tag and 96-bit IV settings-cipher always produces, so a forger
// cannot shorten the tag it has to guess.
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Who may connect the Drive: an admin-tier role (requireAdmin) that also
 *  holds finance:edit. A matrix role that was granted finance rows can enter
 *  receipts, not hand the backups' Google grant to the system. Throws
 *  AuthorizationError (401 no session / 403 otherwise). Registered as a gate
 *  in scripts/check-api-auth.mjs. */
export async function requireDriveConnector(): Promise<Actor> {
  const actor = await requireAdmin();
  if (!hasPermission(actor.role, actor.permissions, 'finance', 'edit')) {
    throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  }
  return actor;
}

export function newDriveNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Seal a Drive state for the `state` query parameter (base64url of the
 *  encrypted blob — URL-safe, tamper-proof, opaque to the browser). */
export function sealDriveState(input: { uid: string; nonce: string; now?: number }): string {
  const state: DriveOAuthState = {
    flow: DRIVE_FLOW,
    nonce: input.nonce,
    uid: input.uid,
    exp: (input.now ?? Date.now()) + DRIVE_STATE_TTL_SEC * 1000,
  };
  const blob = encrypt(JSON.stringify(state));
  return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64url');
}

function isBlob(v: unknown): v is EncryptedBlob {
  return typeof v === 'object' && v !== null
    && typeof (v as EncryptedBlob).iv === 'string'
    && typeof (v as EncryptedBlob).ct === 'string'
    && typeof (v as EncryptedBlob).tag === 'string';
}

/**
 * Open a `state` parameter as a Drive state. Returns null for anything that
 * is not an AUTHENTIC Drive state (a login state, garbage, a blob sealed with
 * another key, a tampered blob) — that is the "not our flow" signal the login
 * callback branches on. Expiry is NOT checked here: an authentic-but-expired
 * state still belongs to the Drive flow and gets a Drive error, not a login one.
 */
export function openDriveState(raw: string | null | undefined): DriveOAuthState | null {
  if (!raw || raw.length > MAX_STATE_CHARS) return null;
  let plain: string;
  try {
    const blob: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!isBlob(blob)) return null;
    if (Buffer.from(blob.iv, 'base64').length !== IV_BYTES || Buffer.from(blob.tag, 'base64').length !== TAG_BYTES) return null;
    plain = decrypt(blob);
  } catch {
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(plain); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const s = parsed as Partial<DriveOAuthState>;
  if (s.flow !== DRIVE_FLOW) return null;
  if (typeof s.nonce !== 'string' || !s.nonce) return null;
  if (typeof s.uid !== 'string' || !s.uid) return null;
  if (typeof s.exp !== 'number' || !Number.isFinite(s.exp)) return null;
  return { flow: DRIVE_FLOW, nonce: s.nonce, uid: s.uid, exp: s.exp };
}

export function isDriveStateExpired(state: DriveOAuthState, now = Date.now()): boolean {
  return state.exp <= now;
}
