-- migrate:up
-- Let the "ספקים" (suppliers) lane be pinned on the board the same way an
-- employee lane already is (14/10/2026, Decisions Log: "התאמת לוח — ספקים +
-- בחירה מפורשת גוברת"). Today the suppliers lane is driven purely by whether
-- there is currently a live item assigned to a supplier (hasSupplierItems in
-- WorkEntityScreen.tsx) — it disappears the moment that count hits zero, and
-- there is no saved preference anywhere that can override that, unlike every
-- employee lane (public.user_work_board_order already lets an employee with
-- zero open items stay pinned once explicitly checked in "התאמת לוח").
--
-- employee_ids was uuid[] because every element used to be an employee id.
-- The fix reuses the exact same column and save mechanism — same table, same
-- full-replace semantics, same API — rather than adding a parallel
-- supplier-visibility column, by widening the element type to text[] and
-- allowing one extra, non-uuid sentinel value: the literal string 'suppliers'
-- (src/lib/constants/workItems.ts, SUPPLIERS_LANE_ID). Its presence/absence
-- and position in the array now mean exactly what they already mean for an
-- employee id: present = always shown (even empty) at that position; absent,
-- with a saved row present at all = hidden; no row at all for (user_id, kind)
-- = fall back to the default algorithm (src/lib/workItems/boardOrder.ts),
-- which now also decides the suppliers lane the same way it decides an
-- employee lane (busiest/"has an open item" rule), appended at the edge.
--
-- No CHECK on element shape (uuid vs 'suppliers'): the only write path is the
-- PUT route's zod schema (workBoardOrderBodySchema), which already enforces
-- this — a DB-level mirror would just duplicate that boundary check for data
-- that cannot otherwise reach this table.

alter table public.user_work_board_order
  alter column employee_ids type text[]
  using employee_ids::text[];

-- ALTER COLUMN TYPE leaves the old default's cast target (::uuid[]) in place
-- even though the column itself is now text[] — harmless (an empty array
-- casts fine either way) but confusing to read later, so pin it explicitly.
alter table public.user_work_board_order
  alter column employee_ids set default '{}'::text[];

comment on column public.user_work_board_order.employee_ids is
  'The exact lane set, in display order. Each element is an employee uuid, or the literal sentinel ''suppliers'' (SUPPLIERS_LANE_ID) for the combined suppliers lane. A stale employee id (deleted/inactive) is dropped at render time, not cleaned up here.';

-- migrate:down
-- array_remove, not a subquery (ALTER COLUMN ... USING rejects subqueries,
-- "cannot use subquery in transform expression") — strips the sentinel first,
-- then a plain array type cast.
alter table public.user_work_board_order
  alter column employee_ids type uuid[]
  using (array_remove(employee_ids, 'suppliers')::uuid[]);

alter table public.user_work_board_order
  alter column employee_ids set default '{}'::uuid[];

comment on column public.user_work_board_order.employee_ids is
  'The exact lane set, in display order. A stale id (deleted/inactive employee) is dropped at render time, not cleaned up here.';
