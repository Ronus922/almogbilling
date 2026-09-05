# Technical Debt

## Rename `whatsapp_instances.user_id` → `webhook_owner_user_id`

**Why.** The name reads like an ownership/authorization field. It is not: it is the
nominal technical owner used for webhook routing and legacy instance association.
The connected WhatsApp instance is shared between all authorized users; access is
decided exclusively by the `whatsapp_chat` permission. The misleading name already
caused a real bug — send/send-bulk/pull/campaigns resolved credentials via
`getInstanceCredsForUser(actor.id)`, so an admin without a personal row got a 503
"לא מחובר מספר וואטסאפ" even though a shared authorized instance existed.

Until the rename lands, the rule is documented in the header of
`src/lib/db/whatsappInstances.ts` and in `COMMENT ON COLUMN` (migration 062).

**Constraint.** Backward-compatible migration — the column must be readable under
both names while old code is still serving (standalone build + systemd restart is
not atomic across a deploy).

### Scope of the rename

- **Schema and indexes** — `whatsapp_instances.user_id` (`NOT NULL UNIQUE
  REFERENCES public.users(id) ON DELETE CASCADE`); the unique constraint and the
  FK both carry the old name and need renaming too.
- **Generated database types** — `WhatsAppInstance` / `InstanceRow` in
  `src/lib/db/whatsappInstances.ts`, plus any regenerated Supabase types.
- **Webhook instance resolution** — `getInstanceByGreenId()`, the only sanctioned
  consumer of the column.
- **All selects, inserts, updates, joins** — `PUBLIC_COLS`, `credsByUser`,
  `getInstanceForUser`, `listInstances`, `createInstance` (insert + duplicate
  clash probe), `updateInstance`.
- **API + UI surfaces** that carry `user_id` in their payload —
  `POST /api/whatsapp/instances`, `settings/components/WhatsAppConnections.tsx`.
- **Tests and fixtures** — anything constructing a `WhatsAppInstance`.
- **Production migration and rollback procedure** — see below.

### Suggested procedure

1. **Expand.** `ALTER TABLE ... RENAME COLUMN user_id TO webhook_owner_user_id;`
   then `CREATE VIEW`/generated column or a plain `user_id` alias is *not*
   possible for writes — so instead: add `webhook_owner_user_id` as a new column,
   backfill, and keep both in sync with a trigger for one release.
2. **Migrate code** to the new name; deploy.
3. **Contract.** Drop `user_id`, drop the sync trigger, rename the unique
   constraint and FK.
4. **Rollback.** Steps 1–2 are reversible by reverting the deploy (the trigger
   keeps `user_id` current). After step 3, rollback requires restoring the column
   from the pre-migration snapshot — take one before contracting.

## React hooks rules demoted to `warn` (infra(2), 05/09/2026)

`eslint-config-next@16` ships `eslint-plugin-react-hooks@7`, whose React-Compiler
rules are `error` by default. The first lint run of the existing UI found:

| Rule | Findings | Files |
|---|---|---|
| `react-hooks/set-state-in-effect` | 89 | 63 |
| `react-hooks/refs` | 14 | 6 |
| `react-hooks/purity` | 2 | 2 |

Fixing them means refactoring component state flow (derive during render,
`useSyncExternalStore`, event handlers instead of effects) — product code, not
infrastructure. `eslint.config.mjs` keeps them visible as **warnings** so `npm run
lint` stays green while the count is worked down. Rule of thumb: a PR must not
increase the count; when it reaches 0 flip the three rules back to `error`.
