# LEGACY_CLEANUP_AUDIT — tasks / issues

Wave: surface the migration-040 `target` (room/area) in the tables, then DROP the
dead legacy columns. **Phase A = display only (safe, done). Phase B = DROP (NOT
run — waits for explicit user approval after visual verification.)**

Date: 2026-06-19

---

## A·Audit — is the target shown in the tables today?

**No.** Both tables still render the legacy columns; the migration-040 target is
wired in the *forms* (TargetField) and persisted, but never displayed in a list:

| Surface | Today shows (legacy) | Source |
|---|---|---|
| tasks table | column "דירה" = `t.apartment_number` | [tasks-table.tsx:84](src/components/tasks/tasks-table.tsx#L84) |
| issues table | column "מיקום" = `locationLabel()` over `location_type`/`location_text` | [issues-table.tsx:22-30,83-88](src/components/issues/issues-table.tsx#L22-L30) |
| tasks kanban | no location/target at all | [tasks-kanban.tsx](src/components/tasks/tasks-kanban.tsx) |
| issues kanban | — (no issues kanban exists) | — |

### Target data path (the source we reuse)
- `target_type` ('room'\|'area') + `target_id` are already projected by the list
  queries ([TASK_COLUMNS](src/lib/db/tasks.ts#L25), [ISSUE_COLUMNS](src/lib/db/issues.ts#L25))
  and present on `TaskWithAssignee` / `IssueWithMeta`.
- The display name lives in the same tables `TargetField` reads via `/api/targets`
  → `listRoomTargets` (debtors.apartment_number / owner_name) + `listAreaTargets`
  (areas.name / area_type). [targets.ts](src/lib/db/targets.ts), [TargetField.tsx](src/components/targets/TargetField.tsx).
- **Phase A approach:** resolve the label *in the list query* (scalar subquery to
  `debtors`/`areas`) → new derived `target_label`, rendered by a shared
  `TargetCell` (icon by type + "דירה N" / area name, "—" when none). Same source
  data as TargetField, no extra client fetch, and it removes the tables' read of
  the legacy columns — the Phase-B prerequisite.

---

## A→B·Read-site map of the DROP candidates (every live read in code)

### 1. `tasks.apartment_number`  (migration 023)
- [db/tasks.ts:28](src/lib/db/tasks.ts#L28) — projected in `TASK_COLUMNS` (list + getTaskById).
- [types/tasks.ts:27](src/lib/types/tasks.ts#L27) — `apartment_number: string | null` on `Task`.
- [tasks-table.tsx:84](src/components/tasks/tasks-table.tsx#L84) — **rendered**. ← Phase A removes this read.
- NOT written: absent from `WRITABLE_COLUMNS`, absent from the `createTask` insert.

### 2. `issues.location_type` / `issues.location_text`  (migration 024)
- [db/issues.ts:25](src/lib/db/issues.ts#L25) — projected in `ISSUE_COLUMNS` (list + getIssueById).
- [db/issues.ts:93](src/lib/db/issues.ts#L93) — **search filter** `or i.location_text ilike …`. ← must be removed for the DROP.
- [types/issues.ts:9,15-16](src/lib/types/issues.ts#L15-L16) — `IssueLocationType` + the two fields on `Issue`.
- [issues-table.tsx:22-30](src/components/issues/issues-table.tsx#L22-L30) — `locationLabel()` + `issueLocationTypeLabel`. ← Phase A removes this read.
- [constants/issues.ts](src/lib/constants/issues.ts) — `ISSUE_LOCATION_TYPES`, `LOCATION_LABELS`, `issueLocationTypeLabel`, `locationTextLabel`. **Only consumer is issues-table** (verified: no other usage). After Phase A these are dead.
- NOT written: absent from `WRITABLE_COLUMNS` (frozen — "no longer written from the form").

### 3. Frozen assignee scalars — `assigned_to_user_id`, `supplier_id` (tasks & issues)
- **Zero live read sites in app code.** All matches are doc comments, migration
  files (023/024/044/045/047), or tests asserting they are *rejected* as input
  ([tests/tasks.test.ts](tests/tasks.test.ts), [tests/issues.test.ts](tests/issues.test.ts)) — none read the columns.
- Replaced by the `entity_assignees` junction (047). The `supplier_id` *filter*
  param uses `assigneeExistsSql` on the junction, not the scalar column.
- FK note: each is `… references public.users/suppliers on delete set null`.
  `DROP COLUMN` drops its own single-column FK automatically — but Phase B will
  drop constraints explicitly if needed.

---

## Phase B — DROP candidates (verified, NOT yet executed)

All five columns have **no remaining live read** once Phase A ships:

| Table | Columns to DROP | Blocker remaining after Phase A |
|---|---|---|
| `tasks` | `apartment_number`, `assigned_to_user_id`, `supplier_id` | remove from `TASK_COLUMNS` + `Task` type |
| `issues` | `location_type`, `location_text`, `assigned_to_user_id`, `supplier_id` | remove from `ISSUE_COLUMNS`, the search filter, `Issue` type, dead constants |

**Phase B is destructive and will NOT run until the user explicitly writes
"תריץ שלב B" / "תפיל את ה-legacy" after visually verifying the target column.**

---

## Status
- **Phase A: implemented + deployed** (see commit/section below). Target now shows
  in tasks table, issues table, and tasks kanban. No DB column dropped.
- **Phase B: pending explicit approval.** No remaining live read site blocks it.
