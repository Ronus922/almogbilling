-- migrate:up
-- Chips, round six (25/11/2026): the guard's pickup screen, cancelling a
-- reception order, paying for extra chips of a web order, and the sweep of
-- leases that were uploaded and never saved.
--
-- Additive only: new NULLABLE columns, new constraints that only speak of
-- those columns, and one new table. No existing column, constraint or row is
-- changed — every row keeps every value it has, and the code that ran before
-- this migration runs on it unchanged.
--
--   1. chip_orders — who collected, and who handed over:
--        collected_by_name    the person of the order who showed an ID (the
--                             name as it stood on the order at that moment);
--        collected_holder_id  that person's holder line, when there is one;
--        handed_over_by / _by_name / handed_over_via
--                             who marked the order collected, and where: the
--                             guard's pickup screen ('pickup') or the orders
--                             table / the issue window ('management').
--      All NULL on every order collected before this migration, and on a
--      reception order (collected the moment it is made, by nobody's click).
--   2. chip_orders.cancelled_by / cancelled_by_name — who cancelled a
--      RECEPTION order. The cancellation itself uses what already exists:
--      status 'rejected', rejected_at, reject_reason (the status CHECK is not
--      touched). A web order never carries these two.
--   3. chip_orders.extra_of_order_id + chip_order_holders.extra_of_holder_id —
--      a reception order that was made for EXTRA chips of a web order (chips
--      added in the web order's window beyond the quantity paid online, and
--      paid in cash or by transfer). The extra chips belong to the reception
--      order; these two links say which web order, and which person of it,
--      they were added for.
--   4. chip_lease_uploads — one row per lease file the ISSUE WINDOW uploaded
--      to the private bucket chip-order-leases: when, and by whom. The hourly
--      purge deletes such a file once it is 24 hours old and no order line,
--      holder line or chip points at it; a save that attaches a lease locks
--      its row first, so a file is never deleted under a save. The purge works
--      from these rows alone — a file with no row here is never deleted.

alter table public.chip_orders
  add column collected_by_name text,
  add column collected_holder_id uuid references public.chip_order_holders (id) on delete set null,
  add column handed_over_by uuid references public.users (id) on delete set null,
  add column handed_over_by_name text,
  add column handed_over_via text,
  add column cancelled_by uuid references public.users (id) on delete set null,
  add column cancelled_by_name text,
  add column extra_of_order_id uuid references public.chip_orders (id) on delete set null;

alter table public.chip_orders
  add constraint chip_orders_collected_by_name_check
    check (collected_by_name is null or length(btrim(collected_by_name)) between 1 and 120),
  add constraint chip_orders_handed_over_via_check
    check (handed_over_via is null or handed_over_via in ('pickup', 'management')),
  -- A hand-over on record always says who made it and where; it is the
  -- hand-over of a COLLECTED order; and one made on the guard's pickup screen
  -- always names who collected.
  add constraint chip_orders_handover_check
    check (
      (handed_over_via is null and handed_over_by_name is null and collected_by_name is null and collected_holder_id is null)
      or (handed_over_via is not null and handed_over_by_name is not null and status = 'collected'
          and (handed_over_via <> 'pickup' or collected_by_name is not null))
    ),
  -- Only a reception order is "cancelled"; a cancelled one is rejected with
  -- its reason, and says who cancelled it.
  add constraint chip_orders_cancelled_check
    check (
      (cancelled_by_name is null and cancelled_by is null)
      or (cancelled_by_name is not null
          and source = 'reception' and status = 'rejected' and rejected_at is not null and reject_reason is not null)
    ),
  -- Only a reception order is "extra chips of" another order.
  add constraint chip_orders_extra_of_check
    check (extra_of_order_id is null or (source = 'reception' and extra_of_order_id <> id));

create index chip_orders_extra_of_idx on public.chip_orders (extra_of_order_id) where extra_of_order_id is not null;

comment on column public.chip_orders.collected_by_name is
  'Who collected the chips: the person of the order who showed an ID, by name as it stood at that moment. Required on the guard''s pickup screen, optional when the management marks the order collected. NULL on every order collected before 25/11/2026 and on a reception order.';
comment on column public.chip_orders.collected_holder_id is
  'The holder line (chip_order_holders) of whoever collected. NULL when the collector is the orderer of an order made before 20/11/2026 (no holder lines), or when nobody was named.';
comment on column public.chip_orders.handed_over_via is
  'Where the order was marked collected: ''pickup'' = the guard''s pickup screen (/chip-pickup); ''management'' = the orders table or the issue window. handed_over_by is the user (NULL once deleted), handed_over_by_name the name at that moment, collected_at the time.';
comment on column public.chip_orders.cancelled_by_name is
  'Who cancelled a RECEPTION order ("בטל הזמנת קבלה", admin / super admin). The cancellation is status ''rejected'' with rejected_at and reject_reason (the required reason); its chips are disabled, never deleted. NULL on every web order, rejected or not.';
comment on column public.chip_orders.extra_of_order_id is
  'A reception order made for EXTRA chips of a web order: chips added in that order''s window beyond the quantity paid online, and paid in cash or by transfer. Points at the web order, whose own lines and total never change. NULL on every other order.';

alter table public.chip_order_holders
  add column extra_of_holder_id uuid references public.chip_order_holders (id) on delete set null;

alter table public.chip_order_holders
  add constraint chip_order_holders_extra_of_check
    check (extra_of_holder_id is null or (source = 'reception' and extra_of_holder_id <> id));

create index chip_order_holders_extra_of_idx on public.chip_order_holders (extra_of_holder_id) where extra_of_holder_id is not null;

comment on column public.chip_order_holders.extra_of_holder_id is
  'On a holder line of a reception order made for extra chips of a web order: the person of the WEB order these chips were added for. The pickup screen and the web order''s window list the chips under that person.';

create table public.chip_lease_uploads (
  object_key   text primary key check (object_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$'),
  uploaded_by  uuid references public.users (id) on delete set null,
  uploaded_at  timestamptz not null default now()
);

create index chip_lease_uploads_uploaded_at_idx on public.chip_lease_uploads (uploaded_at);

comment on table public.chip_lease_uploads is
  'One row per lease file that the issue window uploaded (POST /api/chips/leases) to the private bucket chip-order-leases (key = <uuid>.<ext>). The hourly purge (POST /api/cron/chip-orders-purge) deletes such a file once it is 24 hours old and no chip_order_items / chip_order_holders / chips row points at it, and its row with it; a file that is attached is never deleted, and neither is a file with no row here (the purge never lists the bucket). A save that attaches a lease locks its row first.';

-- migrate:down
-- Refuses while anything of round six is stored: rolling back would lose who
-- collected an order, who cancelled a reception order, and which web order a
-- reception order's extra chips belong to. Deleting those is a human decision.
do $$
begin
  if exists (select 1 from public.chip_orders
              where handed_over_via is not null or collected_by_name is not null
                 or cancelled_by_name is not null or extra_of_order_id is not null) then
    raise exception 'down refused: chip_orders holds hand-over / cancellation / extra-chips records of 25/11/2026';
  end if;
  if exists (select 1 from public.chip_order_holders where extra_of_holder_id is not null) then
    raise exception 'down refused: chip_order_holders holds extra-chips links';
  end if;
end
$$;

drop table public.chip_lease_uploads;

drop index if exists public.chip_order_holders_extra_of_idx;
alter table public.chip_order_holders
  drop constraint chip_order_holders_extra_of_check,
  drop column extra_of_holder_id;

drop index if exists public.chip_orders_extra_of_idx;
alter table public.chip_orders
  drop constraint chip_orders_extra_of_check,
  drop constraint chip_orders_cancelled_check,
  drop constraint chip_orders_handover_check,
  drop constraint chip_orders_handed_over_via_check,
  drop constraint chip_orders_collected_by_name_check,
  drop column extra_of_order_id,
  drop column cancelled_by_name,
  drop column cancelled_by,
  drop column handed_over_via,
  drop column handed_over_by_name,
  drop column handed_over_by,
  drop column collected_holder_id,
  drop column collected_by_name;
