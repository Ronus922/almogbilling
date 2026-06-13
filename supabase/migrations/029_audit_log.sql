-- 029_audit_log.sql
-- Central audit log — cross-cutting infrastructure (NOT a user feature, no UI).
--
-- ADDITIVE ONLY. Creates one new append-only table + three indexes. Touches no
-- existing table, no data migration, no drops. Idempotent (IF NOT EXISTS) —
-- safe to re-run.
--
-- This is the single project-wide audit sink that the per-module callers
-- (debtors / tasks / suppliers / …) will write to gradually via
-- src/lib/db/audit.ts writeAudit(). It supersedes the "central audit deferred"
-- notes scattered in earlier modules (suppliers, tasks). The existing
-- per-entity trails (debtor_events, completed_actions, legal_status_history)
-- are NOT touched — they remain entity-specific timelines.
--
-- Rows are immutable: append-only, so there is no updated_at and no
-- touch_updated_at trigger.
--
-- Design notes:
--   • actor_user_id is a real FK to users with ON DELETE SET NULL — an audit
--     row OUTLIVES the user who created it (actor becomes NULL), and NULL also
--     covers system-initiated events. (This differs from debtor_events, which
--     snapshots actor_name/email instead of FK-ing; callers that want a durable
--     actor label can stash it in metadata.)
--   • entity_type / action are open text (NO rigid CHECK) so new entity kinds
--     and verbs can be added without a migration.
--   • entity_id is text (not uuid) and un-FK'd — polymorphic across entities
--     whose ids may not all be uuid; NULL for bulk/global events.
--   • changes / metadata are jsonb — changes is the recommended { before, after }
--     diff; metadata is free-form context (ip, request id, source, …).
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/029_audit_log.sql

create table if not exists public.audit_log (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid references public.users(id) on delete set null,
  action         text not null,
  entity_type    text not null,
  entity_id      text,
  changes        jsonb,
  metadata       jsonb,
  created_at     timestamptz not null default now()
);

-- Look up the full history of one entity (the primary query).
create index if not exists audit_log_entity_idx
  on public.audit_log (entity_type, entity_id);
-- "What did this user do" + retention-aware sweeps.
create index if not exists audit_log_actor_idx
  on public.audit_log (actor_user_id);
-- Recent-first global feed / time-window queries.
create index if not exists audit_log_created_idx
  on public.audit_log (created_at desc);
