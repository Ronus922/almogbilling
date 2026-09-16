# MULTI_ASSIGN_AUDIT — full mixed Multi-Assignee (junction) Phase 0

Deeper, implementation-focused audit (5 parallel agents) for replacing the
single user-XOR-supplier handler with a polymorphic `entity_assignees` junction
that holds **N users + M suppliers** per task/issue. Supersedes the EPIC-2 stop
audit. Status gate: **046 OK** (suppliers.status ∈ active|archived, 0 outliers).

## Confirmed facts
- **No DB-level XOR constraint** anywhere — the user-XOR-supplier rule is *code-only*
  via `assertSingleAssignee` (`src/lib/validation/assignee.ts`), wired in
  `coerceTaskInput:130` and `coerceIssueInput:103`. Removing it unblocks multi.
- **No junction table** yet (latest migration 046) → create 047.
- **No cmdk/Command** primitive. Only `ui/popover.tsx`, `ui/checkbox.tsx`,
  `ui/combobox.tsx`. The existing mixed multi-select to mirror is the calendar
  **registered-participants picker** (`components/calendar/event-form-panel.tsx`
  ~729-793): custom inline search dropdown + chip cards, value = array. We build a
  Popover+search+Checkbox variant (matches the locked "Popover + Checkbox").
- **KPIs + dashboard need NO change** (`getTaskKpis`, `getIssueKpis`, dashboard
  have zero assignee references).
- `users.email` is NOT NULL; `users.notification_phone` nullable. Suppliers carry
  `email`, `phone`, `mobile`.

## Storage (locked decision #2) — ONE polymorphic table
`public.entity_assignees(id, entity_type∈task|issue, entity_id uuid, assignee_type∈user|supplier, user_id FK→users CASCADE null, supplier_id FK→suppliers CASCADE null, created_at, created_by)` — CHECK exactly-one-of(user_id,supplier_id) matching assignee_type; unique index on `(entity_type, entity_id, assignee_type, coalesce(user_id,supplier_id))` (a literal `UNIQUE(...,user_id,supplier_id)` would NOT dedupe — NULLs are distinct); indexes on `(entity_type,entity_id)`, `(user_id)`, `(supplier_id)`.

## Every call site to change

### DB — `src/lib/db/tasks.ts` / `src/lib/db/issues.ts`
- `TASK_COLUMNS`/`ISSUE_COLUMNS`: drop `assigned_to_user_id, supplier_id` from the app projection (columns stay in DB, additive). The `.split(',')` re-prefix trick forbids inlining a comma-bearing subquery → produce the `assignees` json via a separate correlated subquery in the outer SELECT.
- `WRITABLE_COLUMNS`: remove both FK names (the generic loop must stop writing them).
- `listTasks`/`listIssues` + `getTaskById`/`getIssueById`: replace the two single LEFT JOINs (`assigned_to_name`, `supplier_display_name`) with the `assignees` json-agg subquery.
- Filters: `assignedTo` → `EXISTS(... user_id=$n)`; `supplier_id` → `EXISTS(... supplier_id=$n)` on the junction (both, since app reads only the junction now).
- `createTask`/`createIssue`: wrap in `withTransaction`, insert row + junction rows; re-fetch (RETURNING can't reach the junction).
- `updateTask`/`updateIssue`: transactional; replace junction only when `assignees` provided; the `set.length===0` early-return must still run a junction-only update; existence check needed.
- `getTaskAssignee`/`getIssueAssigneeStatus`: return the *set* of user assignees (for set-diff change-notify).
- `listTasksDueSoon`: return per-task user-assignee *set* (cron fan-out).
- `createTaskFromIssue`: copy the issue's junction rows into the task's junction inside its existing transaction (also fixes the current drop-supplier bug).

### Validation — `src/lib/validation/{tasks,issues}.ts` + `assignee.ts`
- Pull `assigned_to_user_id`/`supplier_id` out of the scalar coercion; add `coerceAssignees(body)` → validated `{assignee_type,id}[]` (uuid, dedupe, cap). Remove the `assertSingleAssignee` calls; retire the XOR helper.

### Routes
- POST/PATCH tasks+issues: parse assignees array, per-supplier existence check, write junction (via db transaction). In-app bell + matrix + reminders + assignment-change now **loop over user assignees** (suppliers: no users row → no in-app/reminder; suppliers get matrix email/WhatsApp only if checked). dedupe keys already `(entity,user)` → loop-safe.
- `create-task/route.ts` + `createTaskFromIssue`: copy + notify all copied user assignees.
- Issue hard-delete: clean up junction rows (no FK on entity_id).

### Notifications engine — `src/lib/reminders/engine.ts`
- `scanTasksDueSoon`: recipients = all user assignees (empty → admins).
- Reminder creation sites (4 routes): enqueue one reminder per user assignee (none → actor).

### UI
- `AssigneeField` (XOR) → new mixed multi-select (Popover+Checkbox, users violet/User + suppliers amber/Wrench, value=array). Both forms consume it.
- Display: `tasks-table` HandlerCell, `issues-table` HandlerCell, `tasks-kanban` footer → map the `assignees` array to multiple pills (violet/User user, amber/Wrench supplier). Kanban currently shows only users + lacks the Wrench import — fix.
- `NotifyMatrix` (EPIC 3): generalize selection to recipient-keyed (`me`, `user:<id>`, `supplier:<id>`), one row per selected assignee; supplier cell availability from supplier email/phone; `dispatchCreateNotifications` gains a supplier path (supplier email + mobile/phone).

## Not changed (verified): `getTaskKpis`/`getIssueKpis`, dashboard, `notifyAdminsOfIssueReported` (admin broadcast, assignee-agnostic), `createNotification`/`notifyTask`/`notifyIssue` primitives (already per-user — just called in a loop).
