import 'server-only';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Central audit-log writer — cross-cutting infrastructure (migration 029).
 *
 * Records one row per business mutation: who acted (actor_user_id, NULL for
 * system events), what they did (action), on which entity (entity_type +
 * polymorphic entity_id), an optional before/after `changes` diff, and
 * free-form `metadata`.
 *
 * FAIL-SAFE BY DESIGN: writing an audit row must NEVER break the business
 * operation that triggered it. Every error is logged and swallowed —
 * writeAudit resolves to void and never throws or rejects. Call it after the
 * business write has succeeded (it is not part of that transaction).
 *
 * Callers are wired in gradually per module; this is the single shared entry
 * point — do not insert into public.audit_log directly elsewhere.
 */
export interface WriteAuditInput {
  /** The acting user. NULL/undefined for system-initiated events. */
  actorUserId?: string | null;
  /** Verb: 'created' | 'updated' | 'deleted' | 'archived' | 'restored' | … (open set). */
  action: string;
  /** Entity kind: 'debtor' | 'task' | 'supplier' | 'contact' | 'building' | 'user' | … (open set). */
  entityType: string;
  /** Polymorphic id of the affected entity (no FK). NULL for bulk/global events. */
  entityId?: string | null;
  /** Optional diff. Recommended shape: { before, after }. */
  changes?: unknown;
  /** Optional free-form context (ip, request id, source, durable actor label, …). */
  metadata?: unknown;
}

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  try {
    await query(
      `insert into public.audit_log
         (actor_user_id, action, entity_type, entity_id, changes, metadata)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        input.actorUserId ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.changes != null ? JSON.stringify(input.changes) : null,
        input.metadata != null ? JSON.stringify(input.metadata) : null,
      ],
    );
  } catch (err) {
    // Best-effort: an audit failure must not surface to the caller.
    logger.error('[writeAudit] failed to record audit entry', {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      err,
    });
  }
}
