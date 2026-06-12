import 'server-only';
import { query, queryOne } from '@/lib/db';
import { encrypt, decrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';
import type { Actor } from '@/lib/auth/actor';

// Per-employee Green API instances (migration 020). One row per user (Wati /
// respond.io style: every agent connects their own WhatsApp number). The token is
// AES-256-GCM-encrypted with the SAME helper SMTP / the legacy global green_api
// credential use, so the data migration could copy the blob verbatim.

export type InstanceState =
  | 'notAuthorized'
  | 'authorized'
  | 'blocked'
  | 'starting'
  | 'yellowCard'
  | 'sleepMode';

/** Public, token-free view (UI / selectors / admin list). */
export interface WhatsAppInstance {
  id: string;
  user_id: string;
  display_name: string;
  green_instance_id: string;
  api_url: string;
  state: InstanceState;
  state_checked_at: string | null;
  created_at: string;
  /** Joined owner identity (admin list / selector labels). */
  owner_name: string | null;
  owner_username: string | null;
}

/** Decrypted credentials — everything the Green API client needs for one call. */
export interface InstanceCreds {
  /** Our instance row id (uuid) — used to tag chat_messages.instance_id. */
  id: string;
  /** Green API idInstance. */
  greenInstanceId: string;
  token: string;
  apiUrl: string;
}

export class InstanceNotConfiguredError extends Error {
  constructor(message = 'לא מחובר מספר וואטסאפ. חבר מכשיר בעמוד ההגדרות (חיבור וואטסאפ אישי).') {
    super(message);
    this.name = 'InstanceNotConfiguredError';
  }
}

export class InstanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceValidationError';
  }
}

interface InstanceRow {
  id: string;
  user_id: string;
  display_name: string;
  green_instance_id: string;
  green_token_enc: EncryptedBlob;
  api_url: string;
  state: InstanceState;
  state_checked_at: string | null;
  created_at: string;
  owner_name: string | null;
  owner_username: string | null;
}

const PUBLIC_COLS = `
  i.id, i.user_id, i.display_name, i.green_instance_id, i.api_url, i.state,
  i.state_checked_at, i.created_at,
  u.full_name as owner_name, u.username as owner_username`;

function toPublic(r: Omit<InstanceRow, 'green_token_enc'>): WhatsAppInstance {
  return {
    id: r.id,
    user_id: r.user_id,
    display_name: r.display_name,
    green_instance_id: r.green_instance_id,
    api_url: r.api_url,
    state: r.state,
    state_checked_at: r.state_checked_at,
    created_at: r.created_at,
    owner_name: r.owner_name,
    owner_username: r.owner_username,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Credential resolution (decrypted) — never leaves the server.
// ─────────────────────────────────────────────────────────────────────

function credsFromRow(r: { id: string; green_instance_id: string; green_token_enc: EncryptedBlob; api_url: string }): InstanceCreds {
  return {
    id: r.id,
    greenInstanceId: r.green_instance_id,
    token: decrypt(r.green_token_enc),
    apiUrl: r.api_url,
  };
}

type CredsRow = { id: string; green_instance_id: string; green_token_enc: EncryptedBlob; api_url: string };
const CREDS_COLS = 'id, green_instance_id, green_token_enc, api_url';

/** Acting user's own instance credentials, or null. */
async function credsByUser(userId: string): Promise<InstanceCreds | null> {
  const row = await queryOne<CredsRow>(
    `select ${CREDS_COLS} from public.whatsapp_instances where user_id = $1 limit 1`,
    [userId],
  );
  return row ? credsFromRow(row) : null;
}

/** Resolve the acting user's own instance credentials. Throws if they have none. */
export async function getInstanceCredsForUser(userId: string): Promise<InstanceCreds> {
  const creds = await credsByUser(userId);
  if (!creds) throw new InstanceNotConfiguredError();
  return creds;
}

/**
 * Resolve the credentials a send should go out through, in the FEWEST queries
 * (the old path did resolveViewInstanceId + getInstanceCredsById = 2+ round-trips
 * on the hot send path). Rules mirror resolveViewInstanceId:
 *   • admin/super_admin with a selected instance → that instance (1 query);
 *   • otherwise → the actor's own instance (1 query);
 *   • admin with neither → fall back to the first instance.
 * Throws InstanceNotConfiguredError when nothing is connected.
 */
export async function resolveSendCreds(actor: Actor, requestedId: string | null): Promise<InstanceCreds> {
  const isAdmin = actor.role === 'admin' || actor.role === 'super_admin';

  if (isAdmin && requestedId) {
    const byId = await getInstanceCredsById(requestedId);
    if (byId) return byId;
  }

  const own = await credsByUser(actor.id);
  if (own) return own;

  if (isAdmin) {
    const first = await queryOne<CredsRow>(
      `select ${CREDS_COLS} from public.whatsapp_instances order by created_at asc limit 1`,
    );
    if (first) return credsFromRow(first);
  }

  throw new InstanceNotConfiguredError();
}

/** Resolve credentials for a specific instance id (admin sending via a chosen
 *  instance, webhook registration, QR polling). Returns null if absent. */
export async function getInstanceCredsById(instanceId: string): Promise<InstanceCreds | null> {
  const row = await queryOne<{ id: string; green_instance_id: string; green_token_enc: EncryptedBlob; api_url: string }>(
    `select id, green_instance_id, green_token_enc, api_url
       from public.whatsapp_instances where id = $1 limit 1`,
    [instanceId],
  );
  return row ? credsFromRow(row) : null;
}

/** Webhook lookup: Green API idInstance → our instance id + owner. */
export async function getInstanceByGreenId(
  greenInstanceId: string,
): Promise<{ id: string; userId: string } | null> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `select id, user_id from public.whatsapp_instances where green_instance_id = $1 limit 1`,
    [greenInstanceId],
  );
  return row ? { id: row.id, userId: row.user_id } : null;
}

// ─────────────────────────────────────────────────────────────────────
// Public reads.
// ─────────────────────────────────────────────────────────────────────

export async function getInstanceForUser(userId: string): Promise<WhatsAppInstance | null> {
  const row = await queryOne<Omit<InstanceRow, 'green_token_enc'>>(
    `select ${PUBLIC_COLS}
       from public.whatsapp_instances i
       join public.users u on u.id = i.user_id
      where i.user_id = $1 limit 1`,
    [userId],
  );
  return row ? toPublic(row) : null;
}

export async function getInstancePublicById(instanceId: string): Promise<WhatsAppInstance | null> {
  const row = await queryOne<Omit<InstanceRow, 'green_token_enc'>>(
    `select ${PUBLIC_COLS}
       from public.whatsapp_instances i
       join public.users u on u.id = i.user_id
      where i.id = $1 limit 1`,
    [instanceId],
  );
  return row ? toPublic(row) : null;
}

/** All instances (admin management list), newest owner activity first. */
export async function listInstances(): Promise<WhatsAppInstance[]> {
  const r = await query<Omit<InstanceRow, 'green_token_enc'>>(
    `select ${PUBLIC_COLS}
       from public.whatsapp_instances i
       join public.users u on u.id = i.user_id
      order by i.created_at asc`,
  );
  return r.rows.map(toPublic);
}

/** Instances an actor may VIEW in the inbox selector: admins → all; others →
 *  only their own (possibly empty). */
export async function listInstancesForActor(actor: Actor): Promise<WhatsAppInstance[]> {
  if (actor.role === 'admin' || actor.role === 'super_admin') return listInstances();
  const own = await getInstanceForUser(actor.id);
  return own ? [own] : [];
}

/**
 * Decide which instance the actor operates on for a request, honouring an
 * explicit selection:
 *   • admin / super_admin → may target ANY instance (the selector); falls back to
 *     their own, else the first instance.
 *   • everyone else       → forced to their own instance, ignoring `requestedId`.
 * Returns null when no instance is resolvable (none connected at all).
 */
export async function resolveViewInstanceId(
  actor: Actor,
  requestedId: string | null,
): Promise<string | null> {
  const isAdmin = actor.role === 'admin' || actor.role === 'super_admin';
  if (isAdmin) {
    if (requestedId) {
      const exists = await queryOne<{ id: string }>(
        `select id from public.whatsapp_instances where id = $1 limit 1`,
        [requestedId],
      );
      if (exists) return exists.id;
    }
    const own = await getInstanceForUser(actor.id);
    if (own) return own.id;
    const first = await queryOne<{ id: string }>(
      `select id from public.whatsapp_instances order by created_at asc limit 1`,
    );
    return first?.id ?? null;
  }
  const own = await getInstanceForUser(actor.id);
  return own?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Mutations (admin).
// ─────────────────────────────────────────────────────────────────────

function cleanInstanceId(raw: string): string {
  const v = raw.replace(/\D+/g, '');
  if (v.length < 6) throw new InstanceValidationError('Instance ID לא תקין');
  return v;
}

function cleanApiUrl(raw: string | undefined | null): string {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return 'https://api.green-api.com';
  if (!/^https?:\/\//i.test(v)) throw new InstanceValidationError('כתובת API לא תקינה');
  return v;
}

export interface CreateInstanceArgs {
  userId: string;
  displayName: string;
  greenInstanceId: string;
  token: string;
  apiUrl?: string | null;
}

export async function createInstance(args: CreateInstanceArgs): Promise<WhatsAppInstance> {
  const displayName = args.displayName.trim();
  if (!displayName) throw new InstanceValidationError('שם תצוגה חסר');
  if (!args.token.trim()) throw new InstanceValidationError('Token חסר');
  const greenInstanceId = cleanInstanceId(args.greenInstanceId);
  const apiUrl = cleanApiUrl(args.apiUrl);
  const tokenEnc = encrypt(args.token.trim());

  // Reject duplicate ownership / instance id with a friendly message instead of a
  // raw unique-violation.
  const clash = await queryOne<{ which: string }>(
    `select case when user_id = $1 then 'user' else 'green' end as which
       from public.whatsapp_instances
      where user_id = $1 or green_instance_id = $2 limit 1`,
    [args.userId, greenInstanceId],
  );
  if (clash?.which === 'user') throw new InstanceValidationError('לעובד זה כבר מוגדר חיבור וואטסאפ');
  if (clash?.which === 'green') throw new InstanceValidationError('Instance ID זה כבר משויך לעובד אחר');

  const inserted = await queryOne<{ id: string }>(
    `insert into public.whatsapp_instances
       (user_id, display_name, green_instance_id, green_token_enc, api_url, state)
     values ($1, $2, $3, $4::jsonb, $5, 'notAuthorized')
     returning id`,
    [args.userId, displayName, greenInstanceId, JSON.stringify(tokenEnc), apiUrl],
  );
  const row = await getInstancePublicById(inserted!.id);
  return row!;
}

export interface UpdateInstanceArgs {
  displayName?: string;
  greenInstanceId?: string;
  token?: string;
  apiUrl?: string | null;
}

export async function updateInstance(id: string, args: UpdateInstanceArgs): Promise<WhatsAppInstance | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let n = 1;

  if (args.displayName !== undefined) {
    const v = args.displayName.trim();
    if (!v) throw new InstanceValidationError('שם תצוגה חסר');
    sets.push(`display_name = $${n++}`); params.push(v);
  }
  if (args.greenInstanceId !== undefined) {
    const v = cleanInstanceId(args.greenInstanceId);
    const clash = await queryOne<{ id: string }>(
      `select id from public.whatsapp_instances where green_instance_id = $1 and id <> $2 limit 1`,
      [v, id],
    );
    if (clash) throw new InstanceValidationError('Instance ID זה כבר משויך לעובד אחר');
    sets.push(`green_instance_id = $${n++}`); params.push(v);
  }
  if (args.apiUrl !== undefined) {
    sets.push(`api_url = $${n++}`); params.push(cleanApiUrl(args.apiUrl));
  }
  if (args.token !== undefined && args.token.trim()) {
    sets.push(`green_token_enc = $${n++}::jsonb`); params.push(JSON.stringify(encrypt(args.token.trim())));
  }
  // Changing credentials invalidates the cached connection state.
  if (args.greenInstanceId !== undefined || (args.token !== undefined && args.token.trim()) || args.apiUrl !== undefined) {
    sets.push(`state = 'notAuthorized'`);
    sets.push(`state_checked_at = null`);
  }
  if (sets.length === 0) return getInstancePublicById(id);

  params.push(id);
  await query(
    `update public.whatsapp_instances set ${sets.join(', ')} where id = $${n}`,
    params,
  );
  return getInstancePublicById(id);
}

export async function deleteInstance(id: string): Promise<boolean> {
  const r = await query(`delete from public.whatsapp_instances where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Persist the connection state observed from getStateInstance / a state webhook. */
export async function updateInstanceState(id: string, state: InstanceState): Promise<void> {
  await query(
    `update public.whatsapp_instances set state = $2, state_checked_at = now() where id = $1`,
    [id, state],
  );
}
