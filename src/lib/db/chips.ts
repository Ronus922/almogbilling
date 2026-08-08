import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import type {
  Chip,
  ChipEvent,
  ChipEventType,
  ChipsKpis,
  ChipListFilters,
  ChipDeactivationReason,
  IssueChipInput,
} from '@/lib/types/chips';

// Closed product rules enforced here (not in routes): no DELETE ever;
// chip_number is never editable; the only way back is inactive -> active
// (reactivate); every mutation writes its chip_events row in the SAME
// transaction (legal_status_history pattern).

/** Soft cap of active chips per contact — exceeded only with a non-empty
 *  limit_override_reason (routes map this to 422 with a Hebrew message). */
const ACTIVE_CHIPS_SOFT_LIMIT = 4;
const MAX_CHIPS_PER_ISSUE = 5;

/** Thrown when an issue request would push a contact past the soft limit
 *  without a limit_override_reason. */
export class ChipLimitError extends Error {
  constructor(message = 'chip_limit_exceeded') {
    super(message);
    this.name = 'ChipLimitError';
  }
}

/** Thrown when a chip_number collides with another ACTIVE chip (partial unique
 *  index chips_number_active_uniq) or repeats within one issue request. */
export class ChipNumberTakenError extends Error {
  readonly chipNumber: string;
  constructor(chipNumber: string) {
    super('chip_number_taken');
    this.name = 'ChipNumberTakenError';
    this.chipNumber = chipNumber;
  }
}

/** Thrown on an invalid state transition (deactivate a non-active chip,
 *  reactivate a non-inactive chip). */
export class ChipStateError extends Error {
  constructor(message = 'invalid_chip_state') {
    super(message);
    this.name = 'ChipStateError';
  }
}

const CHIP_COLUMNS = `
  id, chip_number, chip_type, contact_id, apartment_number, status, resident_role,
  holder_name, holder_phone, issued_at, issued_by, issued_by_name,
  deactivated_at, deactivated_by, deactivated_by_name, deactivation_reason,
  controller_synced, controller_synced_at,
  app_platform, app_invite_status, app_expires_at,
  issuance_fee::float8 as issuance_fee, fee_charged, limit_override_reason, notes,
  created_at, updated_at`;

// Fields a PATCH may touch. chip_number and status are NEVER writable — the
// number is immutable for the chip's lifetime, and status only moves through
// deactivateChip / reactivateChip.
const CHIP_WRITABLE = new Set([
  'contact_id', 'resident_role', 'holder_name', 'holder_phone',
  'app_platform', 'app_invite_status', 'app_expires_at',
  'issuance_fee', 'fee_charged', 'limit_override_reason', 'notes',
]);

/** Append one chip_events row (the log is append-only — never UPDATE/DELETE). */
async function insertChipEvent(
  client: PoolClient,
  chipId: string,
  eventType: ChipEventType,
  actor: { id: string; name: string },
  opts: {
    oldValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
    reason?: string | null;
  } = {},
): Promise<void> {
  await client.query(
    `insert into public.chip_events
       (chip_id, event_type, old_value, new_value, reason, actor_id, actor_name)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      chipId,
      eventType,
      opts.oldValue ? JSON.stringify(opts.oldValue) : null,
      opts.newValue ? JSON.stringify(opts.newValue) : null,
      opts.reason ?? null,
      actor.id,
      actor.name,
    ],
  );
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function listChips(filters: ChipListFilters): Promise<Chip[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Tab → predicate: all → none; active/inactive → status; pending_sync →
  // inactive chips the controller does not know about yet; app → app chips.
  switch (filters.tab) {
    case 'active':
      where.push(`status = 'active'`);
      break;
    case 'inactive':
      where.push(`status = 'inactive'`);
      break;
    case 'pending_sync':
      where.push(`status = 'inactive'`, `controller_synced = false`);
      break;
    case 'app':
      where.push(`chip_type = 'app'`);
      break;
    case 'all':
    default:
      break;
  }

  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.chip_type) {
    params.push(filters.chip_type);
    where.push(`chip_type = $${params.length}`);
  }
  if (filters.contact_id) {
    params.push(filters.contact_id);
    where.push(`contact_id = $${params.length}`);
  }

  let orderBy = 'issued_at desc';
  const term = filters.q?.trim();
  if (term) {
    params.push(`%${term}%`);
    const p = `$${params.length}`;
    where.push(`(chip_number ilike ${p} or apartment_number ilike ${p} or holder_name ilike ${p})`);
    // Exact chip-number hits float to the top of the search result.
    params.push(term);
    orderBy = `(chip_number = $${params.length}) desc, issued_at desc`;
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<Chip>(
    `select ${CHIP_COLUMNS} from public.chips ${whereSql} order by ${orderBy}`,
    params,
  );
  return r.rows;
}

export async function getChipById(id: string): Promise<Chip | null> {
  return queryOne<Chip>(
    `select ${CHIP_COLUMNS} from public.chips where id = $1`,
    [id],
  );
}

export async function getChipsByContact(contactId: string): Promise<Chip[]> {
  const r = await query<Chip>(
    `select ${CHIP_COLUMNS} from public.chips
      where contact_id = $1
      order by case status when 'active' then 0 else 1 end, issued_at desc`,
    [contactId],
  );
  return r.rows;
}

export async function countActiveChipsForContact(contactId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `select count(*)::int as count from public.chips
      where contact_id = $1 and status = 'active'`,
    [contactId],
  );
  return row?.count ?? 0;
}

export async function listChipEvents(chipId: string): Promise<ChipEvent[]> {
  const r = await query<ChipEvent>(
    `select id, chip_id, event_type, old_value, new_value, reason, actor_id, actor_name, created_at
       from public.chip_events
      where chip_id = $1
      order by created_at desc`,
    [chipId],
  );
  return r.rows;
}

export async function getChipsKpis(): Promise<ChipsKpis> {
  const [chips, contacts] = await Promise.all([
    queryOne<{
      active: number;
      app_active: number;
      lost_30d: number;
      pending_controller: number;
    }>(
      `select
         count(*) filter (where status = 'active')::int as active,
         count(*) filter (where chip_type = 'app' and status = 'active')::int as app_active,
         count(*) filter (where deactivation_reason in ('lost','stolen')
                            and deactivated_at >= now() - interval '30 days')::int as lost_30d,
         count(*) filter (where status = 'inactive' and controller_synced = false)::int as pending_controller
       from public.chips`,
    ),
    queryOne<{ apartments_without_active: number; apartments_total: number }>(
      `select
         count(*)::int as apartments_total,
         count(*) filter (where not exists (
                select 1 from public.chips ch
                 where ch.contact_id = c.id and ch.status = 'active'
              ))::int as apartments_without_active
         from public.contacts c
        where c.unit_type = 'apartment'`,
    ),
  ]);
  return {
    active: chips?.active ?? 0,
    app_active: chips?.app_active ?? 0,
    lost_30d: chips?.lost_30d ?? 0,
    apartments_without_active: contacts?.apartments_without_active ?? 0,
    apartments_total: contacts?.apartments_total ?? 0,
    pending_controller: chips?.pending_controller ?? 0,
  };
}

// ── Mutations (each = ONE transaction: chips write + chip_events insert) ──

/**
 * Issue up to 5 chips to one contact, all-or-nothing. The contact row is
 * locked FOR UPDATE so the active-count check and the apartment_number
 * snapshot are race-free. Exceeding the soft limit of 4 active chips per
 * contact requires a non-empty limit_override_reason (else ChipLimitError).
 * A number colliding with another ACTIVE chip → ChipNumberTakenError.
 * Returns the created chips in input order.
 */
export async function issueChip(
  input: IssueChipInput,
  actor: { id: string; name: string },
): Promise<Chip[]> {
  // Trim + reject blanks; a repeated number within one request is a conflict.
  const numbers: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.chip_numbers) {
    const num = raw.trim();
    if (!num) continue;
    if (seen.has(num)) throw new ChipNumberTakenError(num);
    seen.add(num);
    numbers.push(num);
  }
  if (numbers.length === 0 || numbers.length > MAX_CHIPS_PER_ISSUE) {
    throw new Error('invalid_chip_numbers');
  }

  return withTransaction(async (client) => {
    const contact = (
      await client.query<{ id: string; apartment_number: string; unit_type: string }>(
        `select id, apartment_number, unit_type from public.contacts
          where id = $1
          for update`,
        [input.contact_id],
      )
    ).rows[0];
    if (!contact) throw new Error('contact_not_found');

    const activeCount = (
      await client.query<{ count: number }>(
        `select count(*)::int as count from public.chips
          where contact_id = $1 and status = 'active'`,
        [input.contact_id],
      )
    ).rows[0].count;

    const overrideReason = input.limit_override_reason?.trim() ?? '';
    if (activeCount + numbers.length > ACTIVE_CHIPS_SOFT_LIMIT && !overrideReason) {
      throw new ChipLimitError();
    }

    const created: Chip[] = [];
    for (const num of numbers) {
      let chip: Chip;
      try {
        const r = await client.query<Chip>(
          `insert into public.chips
             (chip_number, chip_type, contact_id, apartment_number, resident_role,
              holder_name, holder_phone, issued_by, issued_by_name,
              app_platform, app_invite_status, app_expires_at,
              issuance_fee, fee_charged, limit_override_reason, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           returning ${CHIP_COLUMNS}`,
          [
            num, input.chip_type, input.contact_id, contact.apartment_number,
            input.resident_role ?? null, input.holder_name ?? null, input.holder_phone ?? null,
            actor.id, actor.name,
            input.app_platform ?? null, input.app_invite_status ?? null, input.app_expires_at ?? null,
            input.issuance_fee ?? null, input.fee_charged ?? false,
            input.limit_override_reason ?? null, input.notes ?? null,
          ],
        );
        chip = r.rows[0];
      } catch (err) {
        // Partial unique index chips_number_active_uniq — number held by
        // another ACTIVE chip. The transaction rolls back (all-or-nothing).
        if ((err as { code?: string }).code === '23505') {
          throw new ChipNumberTakenError(num);
        }
        throw err;
      }

      await insertChipEvent(client, chip.id, 'issued', actor, {
        newValue: {
          chip_number: chip.chip_number,
          chip_type: chip.chip_type,
          resident_role: chip.resident_role,
          holder_name: chip.holder_name,
          holder_phone: chip.holder_phone,
        },
      });
      created.push(chip);
    }
    return created;
  });
}

/**
 * active -> inactive. Requires a reason (also a CHECK constraint). By default
 * the controller does NOT yet know — controller_synced=false — unless the
 * caller confirms it was synced right away (controllerSynced=true).
 * Null when the chip does not exist; ChipStateError when not active.
 */
export async function deactivateChip(
  id: string,
  opts: { reason: ChipDeactivationReason; note?: string | null; controllerSynced?: boolean },
  actor: { id: string; name: string },
): Promise<Chip | null> {
  return withTransaction(async (client) => {
    const cur = (
      await client.query<Chip>(
        `select ${CHIP_COLUMNS} from public.chips where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!cur) return null;
    if (cur.status !== 'active') throw new ChipStateError();

    const synced = opts.controllerSynced === true;
    const updated = (
      await client.query<Chip>(
        `update public.chips
            set status = 'inactive',
                deactivated_at = now(),
                deactivated_by = $2,
                deactivated_by_name = $3,
                deactivation_reason = $4,
                controller_synced = $5::boolean,
                controller_synced_at = case when $5::boolean then now() else null end
          where id = $1
          returning ${CHIP_COLUMNS}`,
        [id, actor.id, actor.name, opts.reason, synced],
      )
    ).rows[0];

    await insertChipEvent(client, id, 'deactivated', actor, {
      oldValue: { status: 'active' },
      newValue: { status: 'inactive', deactivation_reason: opts.reason, note: opts.note ?? null },
      reason: opts.reason,
    });
    return updated;
  });
}

/**
 * inactive -> active — the ONLY way back. Requires a free-text reason. If the
 * number was re-coded onto another active chip meanwhile, the partial unique
 * index fires → ChipNumberTakenError (routes map to 409). Reactivation always
 * resets controller_synced=false (the controller must learn about it again).
 * Null when the chip does not exist; ChipStateError when not inactive.
 */
export async function reactivateChip(
  id: string,
  opts: { reason: string },
  actor: { id: string; name: string },
): Promise<Chip | null> {
  return withTransaction(async (client) => {
    const cur = (
      await client.query<Chip>(
        `select ${CHIP_COLUMNS} from public.chips where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!cur) return null;
    if (cur.status !== 'inactive') throw new ChipStateError();

    let updated: Chip;
    try {
      const r = await client.query<Chip>(
        `update public.chips
            set status = 'active',
                deactivated_at = null,
                deactivated_by = null,
                deactivated_by_name = null,
                deactivation_reason = null,
                controller_synced = false,
                controller_synced_at = null
          where id = $1
          returning ${CHIP_COLUMNS}`,
        [id],
      );
      updated = r.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ChipNumberTakenError(cur.chip_number);
      }
      throw err;
    }

    await insertChipEvent(client, id, 'reactivated', actor, {
      oldValue: { status: 'inactive' },
      newValue: { status: 'active' },
      reason: opts.reason,
    });
    return updated;
  });
}

/**
 * Whitelisted partial update — chip_number and status are silently dropped
 * (NEVER writable here). A contact_id change is a reassignment: the new
 * contact must exist, apartment_number is re-snapshotted from it, and the
 * event is 'reassigned'; any other change logs a 'note' event with the
 * changed-keys diff. An empty effective patch returns the row untouched.
 * Null when the chip does not exist.
 */
export async function updateChip(
  id: string,
  patch: Record<string, unknown>,
  actor: { id: string; name: string },
): Promise<Chip | null> {
  return withTransaction(async (client) => {
    const cur = (
      await client.query<Chip>(
        `select ${CHIP_COLUMNS} from public.chips where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!cur) return null;

    const effective: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (CHIP_WRITABLE.has(k) && v !== undefined) effective[k] = v;
    }
    if (Object.keys(effective).length === 0) return cur;

    const reassigned =
      typeof effective.contact_id === 'string' && effective.contact_id !== cur.contact_id;
    let newApartment: string | null = null;
    if (reassigned) {
      const contact = (
        await client.query<{ id: string; apartment_number: string }>(
          `select id, apartment_number from public.contacts where id = $1`,
          [effective.contact_id],
        )
      ).rows[0];
      if (!contact) throw new Error('contact_not_found');
      newApartment = contact.apartment_number;
    }

    // Changed-keys diff (for the 'note' event) — unchanged values drop out.
    const curRec = cur as unknown as Record<string, unknown>;
    const diff: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(effective)) {
      if (v !== curRec[k]) diff[k] = v;
    }
    if (!reassigned && Object.keys(diff).length === 0) return cur;

    const set: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(effective)) {
      vals.push(v);
      set.push(`${k} = $${vals.length}`); // keys are whitelist members only
    }
    if (reassigned && newApartment !== null) {
      vals.push(newApartment);
      set.push(`apartment_number = $${vals.length}`);
    }

    const updated = (
      await client.query<Chip>(
        `update public.chips set ${set.join(', ')} where id = $1 returning ${CHIP_COLUMNS}`,
        vals,
      )
    ).rows[0];

    if (reassigned) {
      await insertChipEvent(client, id, 'reassigned', actor, {
        oldValue: { contact_id: cur.contact_id, apartment_number: cur.apartment_number },
        newValue: { contact_id: updated.contact_id, apartment_number: updated.apartment_number },
      });
    } else {
      await insertChipEvent(client, id, 'note', actor, { newValue: diff });
    }
    return updated;
  });
}

/**
 * Confirm the physical controller learned about a pending change. Idempotent:
 * an already-synced chip returns unchanged with NO event. Null when missing.
 */
export async function markControllerSynced(
  id: string,
  actor: { id: string; name: string },
): Promise<Chip | null> {
  return withTransaction(async (client) => {
    const cur = (
      await client.query<Chip>(
        `select ${CHIP_COLUMNS} from public.chips where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!cur) return null;
    if (cur.controller_synced) return cur;

    const updated = (
      await client.query<Chip>(
        `update public.chips
            set controller_synced = true, controller_synced_at = now()
          where id = $1
          returning ${CHIP_COLUMNS}`,
        [id],
      )
    ).rows[0];

    await insertChipEvent(client, id, 'controller_synced', actor, {
      oldValue: { controller_synced: false },
      newValue: { controller_synced: true },
    });
    return updated;
  });
}
