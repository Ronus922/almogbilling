import 'server-only';
import { randomUUID } from 'node:crypto';
import type { OAuth2Client } from 'google-auth-library';
import { createGoogleClient, getGoogleConfig } from '@/lib/auth/google';
import { getDriveCredentials, setDriveRootFolderId } from '@/lib/db/finance/drive';
import { FINANCE_DRIVE_ROOT_FOLDER } from '@/lib/constants/finance';
import { escapeDriveQuery } from './drive-naming';

/**
 * Thin Google Drive v3 REST client over the stored refresh token. No
 * `googleapis` dependency: three endpoints (files.list, files.create,
 * multipart upload) are all the backup needs.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveNotConnectedError extends Error {
  constructor() {
    super('Google Drive לא מחובר');
    this.name = 'DriveNotConnectedError';
  }
}

export interface DriveSession {
  token: string;
  rootFolderId: string | null;
}

// One OAuth2Client per refresh token: google-auth-library caches the access
// token inside the client and refreshes it only when it expires, so a batch of
// uploads costs one token refresh, not one per file.
let cached: { refreshToken: string; client: OAuth2Client } | null = null;

export async function openDriveSession(): Promise<DriveSession> {
  const cfg = getGoogleConfig();
  if (!cfg) throw new Error('google_oauth_not_configured');
  const creds = await getDriveCredentials();
  if (!creds) throw new DriveNotConnectedError();
  if (!cached || cached.refreshToken !== creds.refreshToken) {
    const client = createGoogleClient(cfg);
    client.setCredentials({ refresh_token: creds.refreshToken });
    cached = { refreshToken: creds.refreshToken, client };
  }
  const { token } = await cached.client.getAccessToken();
  if (!token) throw new Error('drive_access_token_failed');
  return { token, rootFolderId: creds.rootFolderId };
}

async function driveFetch(session: DriveSession, url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`drive_http_${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function findFolder(session: DriveSession, name: string, parentId: string | null): Promise<string | null> {
  const q = [
    `name = '${escapeDriveQuery(name)}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
    `'${parentId ?? 'root'}' in parents`,
  ].join(' and ');
  const res = await driveFetch(
    session,
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1&spaces=drive`,
    { method: 'GET' },
  );
  const data = (await res.json()) as { files?: { id: string; name: string }[] };
  return data.files?.[0]?.id ?? null;
}

async function createFolder(session: DriveSession, name: string, parentId: string | null): Promise<string> {
  const res = await driveFetch(session, `${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function ensureFolder(session: DriveSession, name: string, parentId: string | null): Promise<string> {
  return (await findFolder(session, name, parentId)) ?? createFolder(session, name, parentId);
}

/** The id of `ALMOG — קבלות/<year>/<month>`, creating what is missing. The
 *  root folder id is cached in the DB; a cache that no longer resolves (the
 *  folder was deleted in Drive) is dropped and rebuilt once. */
export async function ensureMonthFolder(session: DriveSession, year: string, month: string): Promise<string> {
  const build = async (root: string) => {
    const y = await ensureFolder(session, year, root);
    return ensureFolder(session, month, y);
  };
  if (session.rootFolderId) {
    try {
      return await build(session.rootFolderId);
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('drive_http_404'))) throw err;
    }
  }
  const root = await ensureFolder(session, FINANCE_DRIVE_ROOT_FOLDER, null);
  await setDriveRootFolderId(root);
  session.rootFolderId = root;
  return build(root);
}

/** Multipart upload (metadata + bytes in one request). Returns the Drive file id. */
export async function uploadToDrive(
  session: DriveSession,
  input: { name: string; mime: string; bytes: Buffer; parentId: string },
): Promise<string> {
  const boundary = `almog_${randomUUID()}`;
  const meta = JSON.stringify({ name: input.name, parents: [input.parentId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: ${input.mime}\r\n\r\n`,
      'utf8',
    ),
    input.bytes,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  const res = await driveFetch(session, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.byteLength) },
    body: new Uint8Array(body),
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}
