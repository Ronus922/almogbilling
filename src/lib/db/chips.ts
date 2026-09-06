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
  ChipResidentRole,
  ChipWithHolder,
  IssueChipsInput,
} from '@/lib/types/chips';
import { isSnapshotRole } from '@/lib/chips/holder';
import {
  ACTIVE_CHIPS_SOFT_LIMIT,
  MAX_CHIPS_PER_GROUP,
  exceedsSoftLimit,
} from '@/lib/chips/issueGroups';

// Closed product rules enforced here (not in routes): no DELETE ever;
// chip_number is never editable; the only way back is inactive -> active
// (reactivate); every mutation writes its chip_events row in the SAME
// transaction (legal_status_history pattern).

/** Thrown when an issue request would push a contact past the soft limit
 *  without a limit_override_reason. */
export class ChipLimitError extends Error {
  constructor(message = 'chip_limit_exceeded') {
    super(message);
    this.name = 'ChipLimitError';
  }
}

/** Thrown when a chip_number collides with another ACTIVE chip (partial unique
 *  index chips_number_active_uniq) or repeats within one issue request.
 *  groupIndex points at the offending group so the UI can mark the right tag. */
export class ChipNumberTakenError extends Error {
  readonly chipNumber: string;
  readonly groupIndex: number | null;
  constructor(chipNumber: string, groupIndex: number | null = null) {
    super('chip_number_taken');
    this.name = 'ChipNumberTakenError';
    this.chipNumber = chipNumber;
    this.groupIndex = groupIndex;
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

// ── Read-time holder resolution (074) ────────────────────────────────────
// Every read joins contacts and resolves the LIVE name for registry roles
// (product rule 3: contacts is the source of truth for names; holder_name is
// an issuance snapshot). holder_chip_count powers the "N צ׳יפים" indicator —
// person identity is (contact_id, resident_role), plus holder_name for
// snapshot roles where the name itself is the identity.

const CHIP_COLUMNS_QUALIFIED = `
  ch.id, ch.chip_number, ch.chip_type, ch.contact_id, ch.apartment_number,
  ch.status, ch.resident_role, ch.holder_name, ch.holder_phone,
  ch.issued_at, ch.issued_by, ch.issued_by_name,
  ch.deactivated_at, ch.deactivated_by, ch.deactivated_by_name, ch.deactivation_reason,
  ch.controller_synced, ch.controller_synced_at,
  ch.app_platform, ch.app_invite_status, ch.app_expires_at,
  ch.issuance_fee::float8 as issuance_fee, ch.fee_charged, ch.limit_override_reason, ch.notes,
  ch.created_at, ch.updated_at`;

const CHIP_HOLDER_SELECT = `
  case ch.resident_role
    when 'owner' then c.owner_name
    when 'tenant' then c.tenant_name
    when 'operator' then c.operator_name
    else null
  end as live_holder_name,
  case ch.resident_role
    when 'owner' then c.owner_phone
    when 'tenant' then c.tenant_phone
    when 'operator' then c.operator_phone
    else null
  end as live_holder_phone,
  (select count(*)::int from public.chips h
    where h.contact_id = ch.contact_id
      and h.resident_role = ch.resident_role
      and (ch.resident_role not in ('other','staff') or h.holder_name = ch.holder_name)
  ) as holder_chip_count`;

const CHIP_FROM_JOINED = `
  from public.chips ch
  left join public.contacts c on c.id = ch.contact_id`;

/** Re-read one chip WITH holder resolution inside a mutation's transaction, so
 *  every mutation responds with the same enriched shape the list/get reads use. */
async function selectChipWithHolder(
  client: PoolClient,
  id: string,
): Promise<ChipWithHolder> {
  const r = await client.query<ChipWithHolder>(
    `select ${CHIP_COLUMNS_QUALIFIED}, ${CHIP_HOLDER_SELECT}, null::text as match_type
       ${CHIP_FROM_JOINED}
      where ch.id = $1`,
    [id],
  );
  return r.rows[0];
}

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

export async function listChips(filters: ChipListFilters): Promise<ChipWithHolder[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const term = filters.q?.trim();

  // Tab → predicate — SKIPPED while searching: search is cross-tab (all
  // statuses) and each result carries its own status pill (product rule 4).
  if (!term) {
    switch (filters.tab) {
      case 'active':
        where.push(`ch.status = 'active'`);
        break;
      case 'inactive':
        where.push(`ch.status = 'inactive'`);
        break;
      case 'pending_sync':
        where.push(`ch.status = 'inactive'`, `ch.controller_synced = false`);
        break;
      case 'app':
        where.push(`ch.chip_type = 'app'`);
        break;
      case 'all':
      default:
        break;
    }
  }

  if (filters.status) {
    params.push(filters.status);
    where.push(`ch.status = $${params.length}`);
  }
  if (filters.chip_type) {
    params.push(filters.chip_type);
    where.push(`ch.chip_type = $${params.length}`);
  }
  if (filters.contact_id) {
    params.push(filters.contact_id);
    where.push(`ch.contact_id = $${params.length}`);
  }

  // Order fragments are assembled from internal constants only (whitelist
  // discipline) — no user input reaches ORDER BY.
  let orderBy = 'ch.issued_at desc';
  let matchTypeSelect = 'null::text as match_type';

  if (term) {
    // Tokenized search: AND between tokens, OR between fields per token.
    // A registry-name hit is ROLE-SCOPED — a tenant_name match only surfaces
    // the tenant's chips of that apartment, never the owner's (rule 4).
    const chipHits: string[] = [];
    const aptHits: string[] = [];
    for (const token of term.split(/\s+/).filter(Boolean)) {
      params.push(`%${token}%`);
      const p = `$${params.length}`;
      chipHits.push(`ch.chip_number ilike ${p}`);
      aptHits.push(`ch.apartment_number ilike ${p}`);
      where.push(`(
        ch.chip_number ilike ${p}
        or ch.apartment_number ilike ${p}
        or ch.holder_name ilike ${p}
        or (ch.resident_role = 'owner' and c.owner_name ilike ${p})
        or (ch.resident_role = 'tenant' and c.tenant_name ilike ${p})
        or (ch.resident_role = 'operator' and c.operator_name ilike ${p})
      )`);
    }

    // Priority: exact chip number → prefix → substring → apartment → name.
    // "נמצא צ׳יפ בלובי" must answer on the first row.
    params.push(term);
    const full = `$${params.length}`;
    const anyChipHit = chipHits.join(' or ');
    const anyAptHit = aptHits.join(' or ');
    orderBy = `case
        when ch.chip_number = ${full} then 0
        when ch.chip_number ilike ${full} || '%' then 1
        when ${anyChipHit} then 2
        when ${anyAptHit} then 3
        else 4
      end, ch.issued_at desc`;
    matchTypeSelect = `case
        when ${anyChipHit} then 'chip_number'
        when ${anyAptHit} then 'apartment'
        else 'holder_name'
      end as match_type`;
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<ChipWithHolder>(
    `select ${CHIP_COLUMNS_QUALIFIED}, ${CHIP_HOLDER_SELECT}, ${matchTypeSelect}
       ${CHIP_FROM_JOINED} ${whereSql} order by ${orderBy}`,
    params,
  );
  return r.rows;
}

export async function getChipById(id: string): Promise<ChipWithHolder | null> {
  return queryOne<ChipWithHolder>(
    `select ${CHIP_COLUMNS_QUALIFIED}, ${CHIP_HOLDER_SELECT}, null::text as match_type
       ${CHIP_FROM_JOINED}
      where ch.id = $1`,
    [id],
  );
}

export async function getChipsByContact(contactId: string): Promise<ChipWithHolder[]> {
  const r = await query<ChipWithHolder>(
    `select ${CHIP_COLUMNS_QUALIFIED}, ${CHIP_HOLDER_SELECT}, null::text as match_type
       ${CHIP_FROM_JOINED}
      where ch.contact_id = $1
      order by case ch.status when 'active' then 0 else 1 end, ch.issued_at desc`,
    [contactId],
  );
  return r.rows;
}

/**
 * All chips of ONE person — the "name → numbers" direction (product rule 4).
 * Person identity is (contact_id, resident_role); for snapshot roles
 * (other/staff) the holder_name narrows to the specific person, because
 * several 'other' holders may share one apartment.
 * Sorted by status (active first) then issuance date.
 */
export async function getChipsByHolder(
  contactId: string,
  role: ChipResidentRole,
  holderName?: string | null,
): Promise<ChipWithHolder[]> {
  const params: unknown[] = [contactId, role];
  let holderPredicate = '';
  if (isSnapshotRole(role) && holderName?.trim()) {
    params.push(holderName.trim());
    holderPredicate = `and ch.holder_name = $${params.length}`;
  }
  const r = await query<ChipWithHolder>(
    `select ${CHIP_COLUMNS_QUALIFIED}, ${CHIP_HOLDER_SELECT}, null::text as match_type
       ${CHIP_FROM_JOINED}
      where ch.contact_id = $1 and ch.resident_role = $2 ${holderPredicate}
      order by case ch.status when 'active' then 0 else 1 end, ch.issued_at desc`,
    params,
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
    queryOne<{
      apartments_without_active: number;
      apartments_total: number;
      apartments_with_debtor: number;
    }>(
      `select
         count(*)::int as apartments_total,
         count(*) filter (where not exists (
                select 1 from public.chips ch
                 where ch.contact_id = c.id and ch.status = 'active'
              ))::int as apartments_without_active,
         count(*) filter (where exists (
                select 1 from public.debtors d where d.contact_id = c.id
              ))::int as apartments_with_debtor
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
    apartments_with_debtor: contacts?.apartments_with_debtor ?? 0,
    pending_controller: chips?.pending_controller ?? 0,
  };
}

// ── Mutations (each = ONE transaction: chips write + chip_events insert) ──

/**
 * Issue chips to one contact for ONE OR MORE holder groups (multi-person
 * window), all in ONE transaction, all-or-nothing. The contact row is locked
 * FOR UPDATE so the active-count check and the apartment_number snapshot are
 * race-free. The soft limit of 4 active chips per contact is counted over
 * existing actives + the SUM of all groups' numbers TOGETHER (a non-empty
 * limit_override_reason is required past it, else ChipLimitError). A number
 * colliding with another ACTIVE chip — or repeated within/across groups —
 * throws ChipNumberTakenError carrying the offending group index.
 * Returns the created chips in input order (groups then numbers).
 */
export async function issueChipGroups(
  input: IssueChipsInput,
  actor: { id: string; name: string },
): Promise<ChipWithHolder[]> {
  // Trim + reject blanks; a repeated number within or ACROSS groups is a
  // conflict (client blocks it too — the server is the authority).
  const seen = new Set<string>();
  const groups: { index: number; numbers: string[] }[] = [];
  for (let i = 0; i < input.groups.length; i++) {
    const numbers: string[] = [];
    for (const raw of input.groups[i].numbers) {
      const num = raw.trim();
      if (!num) continue;
      if (seen.has(num)) throw new ChipNumberTakenError(num, i);
      seen.add(num);
      numbers.push(num);
    }
    if (numbers.length > MAX_CHIPS_PER_GROUP) throw new Error('invalid_chip_numbers');
    if (numbers.length > 0) groups.push({ index: i, numbers });
  }
  if (groups.length === 0) throw new Error('invalid_chip_numbers');
  const totalNew = groups.reduce((s, g) => s + g.numbers.length, 0);

  return withTransaction(async (client) => {
    const contact = (
      await client.query<{
        id: string;
        apartment_number: string;
        unit_type: string;
        owner_name: string | null;
        owner_phone: string | null;
        tenant_name: string | null;
        tenant_phone: string | null;
        operator_name: string | null;
        operator_phone: string | null;
      }>(
        `select id, apartment_number, unit_type,
                owner_name, owner_phone, tenant_name, tenant_phone,
                operator_name, operator_phone
           from public.contacts
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

    // Soft limit over the SUM of all groups — the per-type client split never
    // bypasses the count (clarification 1).
    const overrideReason = input.limit_override_reason?.trim() ?? '';
    if (exceedsSoftLimit(activeCount, totalNew) && !overrideReason) {
      throw new ChipLimitError();
    }

    const created: ChipWithHolder[] = [];
    for (const { index, numbers } of groups) {
      const group = input.groups[index];

      // Holder identity enforcement (product rule 2, CHECK 074): every chip is
      // issued on a specific person's name. Registry roles snapshot the LIVE
      // registry values (an explicit override is allowed and applies to this
      // group's chips only); snapshot roles must bring their own name.
      const role = group.resident_role;
      let holderName = group.holder_name?.trim() || null;
      let holderPhone = group.holder_phone?.trim() || null;
      if (isSnapshotRole(role)) {
        if (!holderName) throw new Error('holder_name_required');
      } else {
        const liveName = {
          owner: contact.owner_name,
          tenant: contact.tenant_name,
          operator: contact.operator_name,
        }[role]?.trim() || null;
        const livePhone = {
          owner: contact.owner_phone,
          tenant: contact.tenant_phone,
          operator: contact.operator_phone,
        }[role]?.trim() || null;
        holderName = holderName ?? liveName;
        holderPhone = holderPhone ?? livePhone;
        if (!holderName) throw new Error('holder_not_in_registry');
      }

      const fee = group.issuance_fee ?? input.issuance_fee ?? null;
      const feeCharged = group.fee_charged ?? input.fee_charged ?? false;

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
              num, group.chip_type, input.contact_id, contact.apartment_number,
              role, holderName, holderPhone,
              actor.id, actor.name,
              group.app_platform ?? null, group.app_invite_status ?? null, group.app_expires_at ?? null,
              fee, feeCharged,
              input.limit_override_reason ?? null, input.notes ?? null,
            ],
          );
          chip = r.rows[0];
        } catch (err) {
          // Partial unique index chips_number_active_uniq — number held by
          // another ACTIVE chip. The transaction rolls back (all-or-nothing).
          if ((err as { code?: string }).code === '23505') {
            throw new ChipNumberTakenError(num, index);
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
        created.push(await selectChipWithHolder(client, chip.id));
      }
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
): Promise<ChipWithHolder | null> {
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
    await client.query(
      `update public.chips
          set status = 'inactive',
              deactivated_at = now(),
              deactivated_by = $2,
              deactivated_by_name = $3,
              deactivation_reason = $4,
              controller_synced = $5::boolean,
              controller_synced_at = case when $5::boolean then now() else null end
        where id = $1`,
      [id, actor.id, actor.name, opts.reason, synced],
    );

    await insertChipEvent(client, id, 'deactivated', actor, {
      oldValue: { status: 'active' },
      newValue: { status: 'inactive', deactivation_reason: opts.reason, note: opts.note ?? null },
      reason: opts.reason,
    });
    return selectChipWithHolder(client, id);
  });
}

/**
 * inactive -> active — the ONLY way back. The reason is OPTIONAL: the one-click
 * toggle reactivates without one, and chip_events.reason stays null. If the
 * number was re-coded onto another active chip meanwhile, the partial unique
 * index fires → ChipNumberTakenError (routes map to 409). Reactivation always
 * resets controller_synced=false (the controller must learn about it again).
 * Null when the chip does not exist; ChipStateError when not inactive.
 */
export async function reactivateChip(
  id: string,
  opts: { reason?: string | null },
  actor: { id: string; name: string },
): Promise<ChipWithHolder | null> {
  return withTransaction(async (client) => {
    const cur = (
      await client.query<Chip>(
        `select ${CHIP_COLUMNS} from public.chips where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!cur) return null;
    if (cur.status !== 'inactive') throw new ChipStateError();

    try {
      await client.query(
        `update public.chips
            set status = 'active',
                deactivated_at = null,
                deactivated_by = null,
                deactivated_by_name = null,
                deactivation_reason = null,
                controller_synced = false,
                controller_synced_at = null
          where id = $1`,
        [id],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ChipNumberTakenError(cur.chip_number);
      }
      throw err;
    }

    await insertChipEvent(client, id, 'reactivated', actor, {
      oldValue: { status: 'inactive' },
      newValue: { status: 'active' },
      reason: opts.reason ?? null,
    });
    return selectChipWithHolder(client, id);
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
): Promise<ChipWithHolder | null> {
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
    if (Object.keys(effective).length === 0) return selectChipWithHolder(client, id);

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
    if (!reassigned && Object.keys(diff).length === 0) return selectChipWithHolder(client, id);

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
    return selectChipWithHolder(client, id);
  });
}

/**
 * Confirm the physical controller learned about a pending change. Idempotent:
 * an already-synced chip returns unchanged with NO event. Null when missing.
 */
export async function markControllerSynced(
  id: string,
  actor: { id: string; name: string },
): Promise<ChipWithHolder | null> {
  return withTransaction(async (client) => {
    const cur = (
      await client.query<Chip>(
        `select ${CHIP_COLUMNS} from public.chips where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!cur) return null;
    if (cur.controller_synced) return selectChipWithHolder(client, id);

    await client.query(
      `update public.chips
          set controller_synced = true, controller_synced_at = now()
        where id = $1`,
      [id],
    );

    await insertChipEvent(client, id, 'controller_synced', actor, {
      oldValue: { controller_synced: false },
      newValue: { controller_synced: true },
    });
    return selectChipWithHolder(client, id);
  });
}
